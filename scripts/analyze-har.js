#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUTPUT_DIR } from "../src/config.js";

const harPath = process.argv[2];
if (!harPath) throw new Error("Usage: npm run analyze-har -- /path/to/chatgpt.com.har");

function isInteresting(url) {
  return /backend-api|venus|research|export|download|markdown|artifact|report|conversation|files/i.test(url);
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    const path = url.pathname
      .replace(/\/backend-api\/conversation\/[^/?#]+/i, "/backend-api/conversation/:conversation_id")
      .replace(/\/backend-api\/f\/conversation\/[^/?#]+/i, "/backend-api/f/conversation/:conversation_id")
      .replace(/\/backend-api\/files\/[^/?#]+/i, "/backend-api/files/:file_id")
      .replace(/\/g\/g-p-[^/?#]+/i, "/g/:project_gizmo_slug")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":uuid")
      .replace(/g-p-[0-9a-f]+/gi, ":project_gizmo_id");
    const queryNames = [...url.searchParams.keys()].sort();
    return `${url.origin}${path}${queryNames.length ? `?${queryNames.map((name) => `${name}=...`).join("&")}` : ""}`;
  } catch {
    return raw.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":uuid");
  }
}

function bodyShape(entry) {
  const postData = entry.request?.postData;
  if (!postData?.text) return null;
  const mimeType = postData.mimeType || "";
  if (!/json/i.test(mimeType)) return { mimeType, textLength: postData.text.length };
  try {
    const json = JSON.parse(postData.text);
    return { mimeType, keys: Object.keys(json).sort() };
  } catch {
    return { mimeType, textLength: postData.text.length };
  }
}

function headerNames(headers = []) {
  return headers
    .map((header) => String(header.name || "").toLowerCase())
    .filter((name) => name && !/cookie|authorization|token|csrf|session|sentinel|device-id|turn-trace|conduit/i.test(name))
    .sort();
}

function sensitiveHeaderNames(headers = []) {
  return headers
    .map((header) => String(header.name || "").toLowerCase())
    .filter((name) => /cookie|authorization|token|csrf|session|sentinel|device-id|turn-trace|conduit/i.test(name))
    .sort();
}

const har = JSON.parse(readFileSync(harPath, "utf8"));
const entries = har.log?.entries || [];
const interesting = entries
  .map((entry, index) => {
    const url = entry.request?.url || "";
    if (!isInteresting(url)) return null;
    const responseHeaders = entry.response?.headers || [];
    return {
      index,
      startedDateTime: entry.startedDateTime,
      method: entry.request?.method,
      status: entry.response?.status,
      mimeType: entry.response?.content?.mimeType || "",
      responseContentSize: entry.response?.content?.size,
      urlPattern: redactUrl(url),
      requestHeaderNames: headerNames(entry.request?.headers),
      sensitiveRequestHeaderNamesPresent: sensitiveHeaderNames(entry.request?.headers),
      responseHeaderNames: headerNames(responseHeaders),
      bodyShape: bodyShape(entry),
    };
  })
  .filter(Boolean);

const grouped = Object.values(
  interesting.reduce((acc, item) => {
    const key = `${item.method} ${item.urlPattern}`;
    acc[key] ||= {
      method: item.method,
      urlPattern: item.urlPattern,
      count: 0,
      statuses: {},
      mimeTypes: {},
      bodyShapes: [],
      examples: [],
    };
    acc[key].count += 1;
    acc[key].statuses[item.status] = (acc[key].statuses[item.status] || 0) + 1;
    acc[key].mimeTypes[item.mimeType || "unknown"] = (acc[key].mimeTypes[item.mimeType || "unknown"] || 0) + 1;
    if (item.bodyShape && !acc[key].bodyShapes.some((shape) => JSON.stringify(shape) === JSON.stringify(item.bodyShape))) acc[key].bodyShapes.push(item.bodyShape);
    if (acc[key].examples.length < 3) acc[key].examples.push({ index: item.index, startedDateTime: item.startedDateTime, status: item.status });
    return acc;
  }, {}),
).sort((a, b) => b.count - a.count);

const data = {
  analyzedAt: new Date().toISOString(),
  source: harPath,
  entryCount: entries.length,
  interestingCount: interesting.length,
  grouped,
};

const dir = resolve(OUTPUT_DIR, "api-verification");
mkdirSync(dir, { recursive: true });
const stamp = data.analyzedAt.replace(/[:.]/g, "-");
const jsonPath = resolve(dir, `har-analysis-${stamp}.json`);
writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
console.log(JSON.stringify({ jsonPath, entryCount: data.entryCount, interestingCount: data.interestingCount, groups: grouped.length }, null, 2));
console.log(JSON.stringify(grouped.slice(0, 40), null, 2));
