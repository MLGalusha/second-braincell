import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { OUTPUT_DIR } from "../src/config.js";

const inputPath = process.argv[2] || resolve(tmpdir(), "chatgpt-send.curl");

function normalizeCurl(value) {
  return String(value || "")
    .replace(/\\\r?\n/g, " ")
    .replace(/\^\r?\n/g, " ")
    .replace(/`\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shellUnquote(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) return text.slice(1, -1);
  return text;
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
    headers[header.slice(0, split).trim().toLowerCase()] = header.slice(split + 1).trim();
  }

  const dataMatch =
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+\$?'((?:\\'|[^'])*)'/) ||
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+"((?:\\"|[^"])*)"/);
  const bodyRaw = dataMatch ? dataMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"') : "";
  const methodMatch = normalized.match(/(?:-X|--request)\s+([A-Z]+)/i);
  const method = methodMatch?.[1]?.toUpperCase() || (bodyRaw ? "POST" : "GET");
  const url = shellUnquote(urlMatch?.[1] || urlMatch?.[2] || urlMatch?.[3] || "");
  return { method, url, headers, bodyRaw };
}

function isSensitiveKey(key) {
  return /token|cookie|csrf|session|auth|secret|sig|signature|account|email|user|org|file|conversation|message|id|uuid|name|title|content|text|body|prompt|input|parts/i.test(
    key,
  );
}

function safeKey(key) {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(key)) return ":uuid_key";
  return key;
}

function shapeOf(value, depth = 0) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, items: depth >= 5 ? { type: "unknown" } : mergeShapes(value.slice(0, 5).map((item) => shapeOf(item, depth + 1))) };
  }
  if (typeof value === "object") {
    if (depth >= 5) return { type: "object" };
    return {
      type: "object",
      keys: Object.fromEntries(
        Object.entries(value)
          .slice(0, 80)
          .map(([key, child]) => [
            safeKey(key),
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
      return { type: "object", keys: Object.fromEntries(keys.map((key) => [key, mergeShapes([a.keys?.[key], b.keys?.[key]])])) };
    }
    if (a.type === "array") return { type: "array", length: Math.max(a.length || 0, b.length || 0), items: mergeShapes([a.items, b.items]) };
    return a;
  }, null);
}

function redactPath(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname
    .replace(/\/backend-api\/conversation\/[^/?#]+/i, "/backend-api/conversation/:conversation_id")
    .replace(/\/backend-api\/f\/conversation\/[^/?#]+/i, "/backend-api/f/conversation/:conversation_id")
    .replace(/\/backend-api\/gizmos\/g-p-[a-z0-9-]+/gi, "/backend-api/gizmos/:project_gizmo_id")}${url.search ? "?..." : ""}`;
}

function isSensitiveHeaderName(name) {
  return /cookie|authorization|token|sentinel|session|device-id|turn-trace|conduit/i.test(name);
}

function markdown(data) {
  return `${[
    "# ChatGPT Send Request cURL Analysis",
    "",
    `Analyzed at: ${data.analyzedAt}`,
    "",
    "Secrets and body values are not included. This is a schema/field-name report only.",
    "",
    `- Method: ${data.method}`,
    `- URL pattern: ${data.urlPattern}`,
    `- Non-sensitive header names: ${data.headerNames.join(", ") || "none"}`,
    `- Sensitive/auth-like header names present: ${data.sensitiveHeaderNamesPresent.join(", ") || "none"}`,
    `- Body top-level fields: ${data.bodyTopLevelFields.join(", ") || "none"}`,
    `- Body content type: ${data.bodyContentType}`,
    "",
    "## Body Shape",
    "",
    "```json",
    JSON.stringify(data.bodyShape, null, 2),
    "```",
    "",
  ].join("\n")}\n`;
}

const curl = readFileSync(inputPath, "utf8");
const parsed = parseCurl(curl);
if (!parsed.url) throw new Error(`Could not parse URL from ${inputPath}`);

let bodyJson = null;
let bodyContentType = "none";
if (parsed.bodyRaw) {
  try {
    bodyJson = JSON.parse(parsed.bodyRaw);
    bodyContentType = "json";
  } catch {
    bodyContentType = "non-json";
  }
}

const data = {
  analyzedAt: new Date().toISOString(),
  source: inputPath,
  method: parsed.method,
  urlPattern: redactPath(parsed.url),
  headerNames: Object.keys(parsed.headers).filter((name) => !isSensitiveHeaderName(name)).sort(),
  sensitiveHeaderNamesPresent: Object.keys(parsed.headers).filter(isSensitiveHeaderName).sort(),
  bodyContentType,
  bodyTopLevelFields: bodyJson && typeof bodyJson === "object" && !Array.isArray(bodyJson) ? Object.keys(bodyJson).sort() : [],
  bodyShape: bodyJson ? shapeOf(bodyJson) : null,
};

const dir = resolve(OUTPUT_DIR, "api-verification");
mkdirSync(dir, { recursive: true });
const stamp = data.analyzedAt.replace(/[:.]/g, "-");
const jsonPath = resolve(dir, `send-curl-analysis-${stamp}.json`);
const mdPath = resolve(dir, `send-curl-analysis-${stamp}.md`);
writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
writeFileSync(mdPath, markdown(data));

console.log(JSON.stringify({ jsonPath, mdPath, method: data.method, urlPattern: data.urlPattern, bodyTopLevelFields: data.bodyTopLevelFields }, null, 2));
