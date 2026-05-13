import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { OUTPUT_DIR } from "../src/config.js";

const DEFAULT_RAW = resolve(tmpdir(), "chatgpt-upload-raw.curl");
const DEFAULT_PROCESS = resolve(tmpdir(), "chatgpt-upload-process.curl");
const DEFAULT_CREATE = resolve(tmpdir(), "chatgpt-upload-create.curl");

function normalizeCurl(value) {
  return String(value || "")
    .replace(/\\\r?\n/g, " ")
    .replace(/\^\r?\n/g, " ")
    .replace(/`\r?\n/g, " ")
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
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+"((?:\\"|[^"])*)"/) ||
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+(@[^\s]+)/);
  const methodMatch = normalized.match(/(?:-X|--request)\s+(?:"([^"]+)"|'([^']+)'|([A-Z]+))/i);
  const bodyRaw = dataMatch ? (dataMatch[1] || "").replace(/\\'/g, "'").replace(/\\"/g, '"') : "";
  return {
    method: (methodMatch?.[1] || methodMatch?.[2] || methodMatch?.[3] || (bodyRaw ? "POST" : "GET")).toUpperCase(),
    url: urlMatch?.[1] || urlMatch?.[2] || urlMatch?.[3] || "",
    headers,
    bodyRaw,
    hasData: Boolean(dataMatch),
    dataIsFileReference: bodyRaw.startsWith("@"),
  };
}

function isSensitiveHeaderName(name) {
  return /cookie|authorization|token|sentinel|session|device-id|turn-trace|conduit|signature|secret/i.test(name);
}

function redactUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname.includes("oaiusercontent.com")) return `${url.origin}/files/:storage_path/raw?[SIGNED_QUERY_REDACTED]`;
  return `${url.origin}${url.pathname
    .replace(/\/backend-api\/files\/[^/?#]+/i, "/backend-api/files/:file_id")
    .replace(/\/file[-_][a-z0-9_-]+/gi, "/:file_id")}${url.search ? "?..." : ""}`;
}

function safeKey(key) {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(key)) return ":uuid_key";
  if (/^file[-_][a-z0-9_-]+$/i.test(key)) return ":file_id_key";
  return key;
}

function isSensitiveKey(key) {
  return /token|cookie|csrf|session|auth|secret|sig|signature|account|email|user|org|file|conversation|message|id|uuid|name|title|content|text|body|path|url/i.test(
    key,
  );
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

function analyze(label, path) {
  const parsed = parseCurl(readFileSync(path, "utf8"));
  let json = null;
  let bodyKind = parsed.hasData ? "non-json" : "none";
  if (parsed.bodyRaw && !parsed.dataIsFileReference) {
    try {
      json = JSON.parse(parsed.bodyRaw);
      bodyKind = "json";
    } catch {}
  } else if (parsed.dataIsFileReference) {
    bodyKind = "file-reference";
  }
  return {
    label,
    source: path,
    method: parsed.method,
    urlPattern: redactUrl(parsed.url),
    host: new URL(parsed.url).hostname,
    nonSensitiveHeaderNames: Object.keys(parsed.headers).filter((name) => !isSensitiveHeaderName(name)).sort(),
    sensitiveHeaderNamesPresent: Object.keys(parsed.headers).filter(isSensitiveHeaderName).sort(),
    bodyKind,
    bodyTopLevelFields: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).sort() : [],
    bodyShape: json ? shapeOf(json) : null,
  };
}

function markdown(data) {
  const lines = [
    "# ChatGPT Upload cURL Analysis",
    "",
    `Analyzed at: ${data.analyzedAt}`,
    "",
    "Secrets, signed URLs, file IDs, and body values are not included.",
    "",
  ];
  for (const item of data.requests) {
    lines.push(`## ${item.label}`);
    lines.push("");
    lines.push(`- Method: ${item.method}`);
    lines.push(`- URL pattern: ${item.urlPattern}`);
    lines.push(`- Host: ${item.host}`);
    lines.push(`- Non-sensitive header names: ${item.nonSensitiveHeaderNames.join(", ") || "none"}`);
    lines.push(`- Sensitive/auth-like header names present: ${item.sensitiveHeaderNamesPresent.join(", ") || "none"}`);
    lines.push(`- Body kind: ${item.bodyKind}`);
    lines.push(`- Body top-level fields: ${item.bodyTopLevelFields.join(", ") || "none"}`);
    lines.push("- Body shape:");
    lines.push("```json");
    lines.push(JSON.stringify(item.bodyShape, null, 2));
    lines.push("```");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

const data = {
  analyzedAt: new Date().toISOString(),
  requests: [
    analyze("create-upload-or-file-id", DEFAULT_CREATE),
    analyze("raw-object-storage-upload", DEFAULT_RAW),
    analyze("process-upload-stream", DEFAULT_PROCESS),
  ],
};

const dir = resolve(OUTPUT_DIR, "api-verification");
mkdirSync(dir, { recursive: true });
const stamp = data.analyzedAt.replace(/[:.]/g, "-");
const jsonPath = resolve(dir, `upload-curl-analysis-${stamp}.json`);
const mdPath = resolve(dir, `upload-curl-analysis-${stamp}.md`);
writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
writeFileSync(mdPath, markdown(data));

console.log(JSON.stringify({ jsonPath, mdPath, requests: data.requests.map(({ label, method, urlPattern, bodyKind, bodyTopLevelFields }) => ({ label, method, urlPattern, bodyKind, bodyTopLevelFields })) }, null, 2));
