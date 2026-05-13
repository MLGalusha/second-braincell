import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUTPUT_DIR } from "../src/config.js";

const DEFAULT_CURL_PATH = "/tmp/chatgpt-send.curl";
const DEFAULT_PROMPT = "API replay verification. Reply OK.";

function normalizeCurl(value) {
  return String(value || "")
    .replace(/\\\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCurl(source) {
  const normalized = normalizeCurl(source);
  const urlMatch = normalized.match(/curl\s+(?:--location\s+)?(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const headers = {};
  const headerRe = /(?:-H|--header)\s+(?:"([^"]*)"|'([^']*)'|([^\s][^\s]*))/g;
  for (const match of normalized.matchAll(headerRe)) {
    const header = match[1] || match[2] || match[3] || "";
    const split = header.indexOf(":");
    if (split === -1) continue;
    const name = header.slice(0, split).trim().toLowerCase();
    if (["host", "content-length"].includes(name)) continue;
    headers[name] = header.slice(split + 1).trim();
  }
  const dataMatch =
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+\$?'((?:\\'|[^'])*)'/) ||
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+"((?:\\"|[^"])*)"/);
  const bodyRaw = dataMatch ? dataMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"') : "";
  const methodMatch = normalized.match(/(?:-X|--request)\s+([A-Z]+)/i);
  return {
    method: methodMatch?.[1]?.toUpperCase() || (bodyRaw ? "POST" : "GET"),
    url: urlMatch?.[1] || urlMatch?.[2] || urlMatch?.[3] || "",
    headers,
    bodyRaw,
  };
}

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function redactPath(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname
    .replace(/\/backend-api\/conversation\/[^/?#]+/i, "/backend-api/conversation/:conversation_id")
    .replace(/\/backend-api\/f\/conversation\/[^/?#]+/i, "/backend-api/f/conversation/:conversation_id")
    .replace(/\/backend-api\/gizmos\/g-p-[a-z0-9-]+/gi, "/backend-api/gizmos/:project_gizmo_id")}${url.search ? "?..." : ""}`;
}

function sanitizeBody(body, prompt) {
  if (!body || typeof body !== "object") throw new Error("Captured send body is not a JSON object.");
  if (!Array.isArray(body.messages) || !body.messages[0]) throw new Error("Captured send body has no messages[0].");

  const next = structuredClone(body);
  const message = next.messages[0];
  message.id = randomUUID();
  message.create_time = Date.now() / 1000;
  message.content = message.content || {};
  message.content.content_type = message.content.content_type || "text";
  message.content.parts = [prompt];

  if (message.metadata && typeof message.metadata === "object") {
    delete message.metadata.timestamp_;
  }

  if (!next.supported_encodings) next.supported_encodings = ["v1"];
  next.timezone = next.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  next.timezone_offset_min = new Date().getTimezoneOffset();
  return next;
}

function summarizeStream(text) {
  const lines = text.split(/\r?\n/);
  const eventTypes = new Map();
  let dataLineCount = 0;
  let jsonDataLineCount = 0;
  let finishSeen = false;
  let errorSeen = false;

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    dataLineCount += 1;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      finishSeen = finishSeen || payload === "[DONE]";
      continue;
    }
    try {
      const json = JSON.parse(payload);
      jsonDataLineCount += 1;
      const type = json.type || json.event || json.message?.metadata?.message_type || "json";
      eventTypes.set(type, (eventTypes.get(type) || 0) + 1);
      if (json.error || type === "error") errorSeen = true;
    } catch {
      eventTypes.set("non-json", (eventTypes.get("non-json") || 0) + 1);
    }
  }

  return {
    dataLineCount,
    jsonDataLineCount,
    eventTypes: Object.fromEntries([...eventTypes.entries()].sort()),
    finishSeen,
    errorSeen,
  };
}

function markdownReport(data) {
  return `${[
    "# ChatGPT Send Replay Verification",
    "",
    `Verified at: ${data.verifiedAt}`,
    "",
    "Secrets, request body values, and response content are not included.",
    "",
    `- Method: ${data.method}`,
    `- URL pattern: ${data.urlPattern}`,
    `- Status: ${data.status}`,
    `- OK: ${data.ok}`,
    `- Content-Type: ${data.contentType || "unknown"}`,
    `- Prompt length: ${data.promptLength}`,
    `- Response bytes: ${data.responseBytes}`,
    "",
    "## Stream Summary",
    "",
    "```json",
    JSON.stringify(data.streamSummary, null, 2),
    "```",
    "",
  ].join("\n")}\n`;
}

async function main() {
  const curlPath = getArg("--curl", DEFAULT_CURL_PATH);
  const prompt = getArg("--prompt", DEFAULT_PROMPT);
  const parsed = parseCurl(readFileSync(curlPath, "utf8"));
  if (!parsed.url) throw new Error(`Could not parse URL from ${curlPath}`);
  if (parsed.method !== "POST") throw new Error(`Expected POST cURL, got ${parsed.method}`);

  const body = sanitizeBody(JSON.parse(parsed.bodyRaw), prompt);
  const response = await fetch(parsed.url, {
    method: "POST",
    headers: {
      ...parsed.headers,
      accept: parsed.headers.accept || "text/event-stream",
      "content-type": parsed.headers["content-type"] || "application/json",
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const contentType = response.headers.get("content-type") || "";
  const responseText = await response.text();

  const data = {
    verifiedAt: new Date().toISOString(),
    method: "POST",
    urlPattern: redactPath(parsed.url),
    status: response.status,
    ok: response.ok,
    contentType,
    promptLength: prompt.length,
    responseBytes: Buffer.byteLength(responseText),
    streamSummary: summarizeStream(responseText),
  };

  const dir = resolve(OUTPUT_DIR, "api-verification");
  mkdirSync(dir, { recursive: true });
  const stamp = data.verifiedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `send-replay-${stamp}.json`);
  const mdPath = resolve(dir, `send-replay-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(mdPath, markdownReport(data));

  console.log(JSON.stringify({ jsonPath, mdPath, status: data.status, ok: data.ok, streamSummary: data.streamSummary }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
