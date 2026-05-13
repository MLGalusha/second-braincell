import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUTPUT_DIR, PROJECT_URL } from "../src/config.js";

const COOKIE_ENV = "CHATGPT_COOKIE";
const CURL_ENV = "CHATGPT_CURL";
const HEADERS_ENV = "CHATGPT_REQUEST_HEADERS";
const PROJECT_ID_ENV = "CHATGPT_PROJECT_ID";
const BASE_URL = "https://chatgpt.com";

function projectIdFromUrl() {
  return PROJECT_URL.match(/\/g\/(g-p-[0-9a-f]+)(?:-|\/|$)/i)?.[1] || null;
}

function normalizeSecret(value) {
  return String(value || "")
    .replace(/\\\r?\n/g, " ")
    .replace(/[\r\n]\s*/g, "")
    .trim();
}

function parseHeaderLines(value) {
  const headers = {};
  for (const line of String(value || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (["host", "content-length"].includes(name)) continue;
    headers[name] = match[2];
  }
  return headers;
}

function parseCurlHeaders(value) {
  const headers = {};
  const source = normalizeSecret(value);
  const headerRe = /(?:-H|--header)\s+(?:"([^"]*)"|'([^']*)'|([^\\\s][^\s]*))/g;
  for (const match of source.matchAll(headerRe)) {
    const header = match[1] || match[2] || match[3] || "";
    const split = header.indexOf(":");
    if (split === -1) continue;
    const name = header.slice(0, split).trim().toLowerCase();
    if (["host", "content-length"].includes(name)) continue;
    headers[name] = header.slice(split + 1).trim();
  }
  return headers;
}

function getAuthHeaders() {
  let headers = {};
  if (process.env[CURL_ENV]) headers = { ...headers, ...parseCurlHeaders(process.env[CURL_ENV]) };
  if (process.env[HEADERS_ENV]) headers = { ...headers, ...parseHeaderLines(process.env[HEADERS_ENV]) };

  let stdin = "";
  if (!process.stdin.isTTY) stdin = readFileSync(0, "utf8");
  if (stdin.trim()) {
    if (/curl\s+/.test(stdin) || /\s-H\s+|--header\s+/.test(stdin)) headers = { ...headers, ...parseCurlHeaders(stdin) };
    else headers = { ...headers, ...parseHeaderLines(stdin) };
  }

  const rawCookie = process.env[COOKIE_ENV];
  if (rawCookie && rawCookie.trim()) headers.cookie = normalizeSecret(rawCookie);

  if (!headers.cookie) {
    throw new Error(
      [
        `Missing auth headers. Provide one of:`,
        `- ${COOKIE_ENV}=... npm run verify-api`,
        `- ${CURL_ENV}='curl ...' npm run verify-api`,
        `- copy request headers or Copy as cURL from DevTools, then pipe that text into npm run verify-api`,
      ].join("\n"),
    );
  }
  return headers;
}

function isSensitiveKey(key) {
  return /token|cookie|csrf|session|auth|secret|sig|signature|account|email|user|org|file|conversation|message|id|uuid|name|title|content|text|body|prompt/i.test(
    key,
  );
}

function safeShapeKey(key) {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(key)) return ":uuid_key";
  if (/^file[-_][a-z0-9_-]+$/i.test(key)) return ":file_id_key";
  if (/^g-p-[a-z0-9-]+$/i.test(key)) return ":project_gizmo_id_key";
  if (/^g-[a-z0-9]+$/i.test(key)) return ":gizmo_id_key";
  return key;
}

function shapeOf(value, depth = 0) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: depth >= 5 ? { type: "unknown" } : mergeShapes(value.slice(0, 5).map((item) => shapeOf(item, depth + 1))),
    };
  }
  if (typeof value === "object") {
    if (depth >= 5) return { type: "object" };
    return {
      type: "object",
      keys: Object.fromEntries(
        Object.entries(value)
          .slice(0, 80)
          .map(([key, child]) => [
            safeShapeKey(key),
            isSensitiveKey(key) && (child === null || typeof child !== "object")
              ? { type: child === null ? "null" : typeof child, redacted: true }
              : shapeOf(child, depth + 1),
          ]),
      ),
    };
  }
  return { type: typeof value };
}

function mergeShapes(shapes) {
  const clean = shapes.filter(Boolean);
  if (!clean.length) return { type: "unknown" };
  return clean.reduce((a, b) => {
    if (!a) return b;
    if (a.type !== b.type) return { type: [...new Set([a.type, b.type].join("|").split("|"))].sort().join("|") };
    if (a.type === "object") {
      const keys = [...new Set([...Object.keys(a.keys || {}), ...Object.keys(b.keys || {})])].sort();
      return {
        type: "object",
        keys: Object.fromEntries(keys.map((key) => [key, mergeShapes([a.keys?.[key], b.keys?.[key]])])),
      };
    }
    if (a.type === "array") return { type: "array", length: Math.max(a.length || 0, b.length || 0), items: mergeShapes([a.items, b.items]) };
    return a;
  }, null);
}

function findFirstConversationId(value, depth = 0) {
  if (!value || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstConversationId(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/^(id|conversation_id)$/.test(key) && typeof child === "string" && child.length > 8) return child;
    }
    for (const child of Object.values(value)) {
      const found = findFirstConversationId(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function redactPath(path) {
  return path
    .replace(/\/backend-api\/conversation\/[^/?#]+/i, "/backend-api/conversation/:conversation_id")
    .replace(/\/backend-api\/gizmos\/g-p-[a-z0-9-]+/gi, "/backend-api/gizmos/:project_gizmo_id")
    .replace(/\/file[-_][a-z0-9_-]+/gi, "/:file_id");
}

async function callJson({ authHeaders, path, label }) {
  const headers = {
    accept: "application/json",
    origin: BASE_URL,
    referer: `${BASE_URL}/`,
    "user-agent": "Mozilla/5.0 ChatGPTProjectRunner/endpoint-verifier",
    ...authHeaders,
  };
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers,
    redirect: "manual",
  });
  const contentType = response.headers.get("content-type") || "";
  let json = null;
  let parseError = null;
  if (contentType.includes("application/json")) {
    try {
      json = await response.json();
    } catch (error) {
      parseError = String(error.message || error);
    }
  } else {
    await response.arrayBuffer();
  }
  return {
    label,
    method: "GET",
    pathPattern: redactPath(path),
    status: response.status,
    ok: response.ok,
    contentType,
    topLevelKeys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).sort() : [],
    responseShape: json ? shapeOf(json) : null,
    parseError,
    conversationId: json ? findFirstConversationId(json) : null,
  };
}

function withoutPrivateValues(result) {
  const { conversationId, ...safe } = result;
  return { ...safe, foundConversationId: Boolean(conversationId) };
}

function markdownReport(data) {
  const lines = [
    "# ChatGPT Direct API Endpoint Verification",
    "",
    `Verified at: ${data.verifiedAt}`,
    `Project ID source: ${data.projectIdSource}`,
    "",
    "Secrets are not included in this report. Response values are collapsed to types/redacted shapes.",
    "",
    "## Results",
    "",
  ];
  for (const result of data.results) {
    lines.push(`### ${result.label}`);
    lines.push("");
    lines.push(`- Endpoint: \`${result.pathPattern}\``);
    lines.push(`- Method: ${result.method}`);
    lines.push(`- Status: ${result.status}`);
    lines.push(`- OK: ${result.ok}`);
    lines.push(`- Content-Type: ${result.contentType || "unknown"}`);
    lines.push(`- Top-level keys: ${result.topLevelKeys.join(", ") || "none"}`);
    lines.push(`- Found conversation id: ${result.foundConversationId}`);
    lines.push("- Response shape:");
    lines.push("```json");
    lines.push(JSON.stringify(result.responseShape, null, 2));
    lines.push("```");
    if (result.parseError) lines.push(`- Parse error: ${result.parseError}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const authHeaders = getAuthHeaders();
  const projectId = process.env[PROJECT_ID_ENV] || projectIdFromUrl();
  if (!projectId) throw new Error(`Could not determine project id. Set ${PROJECT_ID_ENV}=g-p-...`);

  const rawResults = [];
  const projectChats = await callJson({
    authHeaders,
    path: `/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=0`,
    label: "project-chat-list",
  });
  rawResults.push(projectChats);

  if (projectChats.ok && projectChats.conversationId) {
    rawResults.push(
      await callJson({
        authHeaders,
        path: `/backend-api/conversation/${encodeURIComponent(projectChats.conversationId)}`,
        label: "conversation-history",
      }),
    );
  }

  const data = {
    verifiedAt: new Date().toISOString(),
    projectIdSource: process.env[PROJECT_ID_ENV] ? PROJECT_ID_ENV : "PROJECT_URL",
    results: rawResults.map(withoutPrivateValues),
  };

  const dir = resolve(OUTPUT_DIR, "api-verification");
  mkdirSync(dir, { recursive: true });
  const stamp = data.verifiedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(dir, `verification-${stamp}.json`);
  const mdPath = resolve(dir, `verification-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(mdPath, markdownReport(data));

  console.log(JSON.stringify({ jsonPath, mdPath, results: data.results.map(({ label, status, ok }) => ({ label, status, ok })) }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
