import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileInfo } from "./util.js";
import { loadLocalConfig, loadLocalHeaders } from "./local-config.js";
import { bodyForKind } from "./request-builders.js";

export const DEFAULT_API_CURL_PATH = "/tmp/chatgpt-send.curl";

export function normalizeCurl(value) {
  return String(value || "")
    .replace(/\\\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCurl(source) {
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

export function loadCurlTemplate(path = DEFAULT_API_CURL_PATH) {
  const parsed = parseCurl(readFileSync(path, "utf8"));
  if (!parsed.url) throw new Error(`Could not parse URL from ${path}`);
  if (parsed.method !== "POST") throw new Error(`Expected POST cURL, got ${parsed.method}`);
  if (!parsed.bodyRaw) throw new Error(`Captured cURL has no request body: ${path}`);
  return parsed;
}

export function prepareMessageBody(body, prompt, { model, thinkingEffort, attachments = [] } = {}) {
  const next = structuredClone(body);
  const message = next.messages?.[0];
  if (!message) throw new Error("Captured send body has no messages[0].");
  message.id = randomUUID();
  message.create_time = Date.now() / 1000;
  message.content = message.content || {};
  message.content.content_type = "text";
  message.content.parts = [prompt];
  if (attachments.length) {
    message.metadata = message.metadata && typeof message.metadata === "object" ? message.metadata : {};
    message.metadata.attachments = attachments.map((attachment) => ({
      id: attachment.id,
      size: attachment.size,
      name: attachment.name,
      file_token_size: attachment.fileTokenSize ?? 0,
      source: attachment.source || "upload",
      is_big_paste: false,
    }));
  }
  if (message.metadata && typeof message.metadata === "object") delete message.metadata.timestamp_;

  if (model) next.model = model;
  if (thinkingEffort) next.thinking_effort = thinkingEffort;
  next.timezone = next.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  next.timezone_offset_min = new Date().getTimezoneOffset();
  return next;
}

function apiHeaders(headers, accept = "application/json") {
  return { ...headers, accept, "content-type": "application/json" };
}

async function parseJsonOrThrow(response, label) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned non-JSON response: ${response.status}`);
  }
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

export function parseUploadProcessStream(text) {
  const events = [];
  let final = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      events.push(json);
      final = json;
    } catch {
      events.push({ raw: payload });
    }
  }
  return { events, final };
}

export async function uploadFile({ headers, filePath, useCase = "my_files", indexForRetrieval = true } = {}) {
  const info = fileInfo(filePath);
  const createResponse = await fetch("https://chatgpt.com/backend-api/files", {
    method: "POST",
    headers: apiHeaders(headers),
    body: JSON.stringify({
      file_name: info.name,
      file_size: info.size,
      reset_rate_limits: false,
      timezone_offset_min: new Date().getTimezoneOffset(),
      use_case: useCase,
    }),
  });
  const created = await parseJsonOrThrow(createResponse, "create upload");
  const fileId = created.file_id || created.id;
  const uploadUrl = created.upload_url;
  if (!fileId || !uploadUrl) throw new Error("Create upload response did not include file_id and upload_url.");

  const bytes = readFileSync(info.path);
  const rawResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": info.type,
      "x-ms-blob-type": "BlockBlob",
    },
    body: bytes,
  });
  if (!rawResponse.ok) throw new Error(`raw upload failed: ${rawResponse.status} ${await rawResponse.text()}`);

  const processResponse = await fetch("https://chatgpt.com/backend-api/files/process_upload_stream", {
    method: "POST",
    headers: apiHeaders(headers, "text/event-stream"),
    body: JSON.stringify({
      entry_surface: "chat_composer",
      file_id: fileId,
      file_name: info.name,
      index_for_retrieval: indexForRetrieval,
      use_case: useCase,
    }),
  });
  const processText = await processResponse.text();
  if (!processResponse.ok) throw new Error(`process upload failed: ${processResponse.status} ${processText}`);
  const processed = parseUploadProcessStream(processText);

  return {
    id: fileId,
    name: info.name,
    size: info.size,
    mimeType: info.type,
    source: "upload",
    createStatus: createResponse.status,
    rawStatus: rawResponse.status,
    processStatus: processResponse.status,
    processEvents: processed.events.length,
    fileTokenSize: processed.final?.file_token_size ?? processed.final?.fileTokenSize ?? 0,
  };
}

function extractTextFromJson(value) {
  const chunks = [];
  const visit = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const authorRole = node.message?.author?.role || node.author?.role;
    const content = node.message?.content || node.content;
    if (authorRole === "assistant" && content) {
      if (Array.isArray(content.parts)) {
        for (const part of content.parts) if (typeof part === "string") chunks.push(part);
      }
      if (typeof content.text === "string") chunks.push(content.text);
    }
    if (typeof node.v === "string" && /message|delta|append|patch/i.test(String(node.p || node.o || node.type || ""))) chunks.push(node.v);
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(value);
  return chunks;
}

export function parseEventStream(text) {
  const chunks = [];
  const eventTypes = new Map();
  let errorSeen = false;
  let finishSeen = false;
  let conversationId = null;
  const findConversationId = (value, depth = 0) => {
    if (!value || depth > 6) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findConversationId(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (/^conversation_id$/.test(key) && typeof child === "string" && child.length > 8) return child;
      }
      for (const child of Object.values(value)) {
        const found = findConversationId(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      finishSeen = true;
      continue;
    }
    if (!payload) continue;
    try {
      const json = JSON.parse(payload);
      const type = json.type || json.event || "json";
      eventTypes.set(type, (eventTypes.get(type) || 0) + 1);
      if (json.error || type === "error") errorSeen = true;
      conversationId = conversationId || findConversationId(json);
      chunks.push(...extractTextFromJson(json));
    } catch {
      eventTypes.set("non-json", (eventTypes.get("non-json") || 0) + 1);
    }
  }
  const meaningful = chunks.filter((chunk) => chunk && !/^(finished_successfully|finished_partial_completion)$/.test(chunk.trim()));
  const responseText = meaningful.at(-1) || meaningful.join("").trim();
  return { responseText, conversationId, finishSeen, errorSeen, eventTypes: Object.fromEntries([...eventTypes.entries()].sort()) };
}

export function projectIdFromUrl(url = loadLocalConfig({ required: false })?.projectUrl || process.env.CHATGPT_PROJECT_URL || "") {
  return url.match(/\/g\/(g-p-[0-9a-f]+)(?:-|\/|$)/i)?.[1] || null;
}

export async function fetchLatestAssistantText(headers, conversationId) {
  let id = conversationId;
  const jsonHeaders = { ...headers, accept: "application/json" };
  if (!id) {
    const projectId = projectIdFromUrl();
    if (!projectId) return "";
    const list = await fetch(`https://chatgpt.com/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=0`, {
      headers: jsonHeaders,
    }).then((response) => response.json());
    id = list.items?.[0]?.id;
  }
  if (!id) return "";
  const history = await fetch(`https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`, { headers: jsonHeaders }).then((response) =>
    response.json(),
  );
  const messages = Object.values(history.mapping || {})
    .map((node) => node?.message)
    .filter((message) => message?.author?.role === "assistant");
  const last = messages.at(-1);
  return (last?.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
}

export async function fetchConversation(headers, conversationId) {
  return fetch(`https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
    headers: { ...headers, accept: "application/json" },
  }).then((response) => response.json());
}

export function latestAssistantTextFromConversation(history) {
  const messages = Object.values(history.mapping || {})
    .map((node) => node?.message)
    .filter((message) => {
      if (message?.author?.role !== "assistant") return false;
      if (message.metadata?.is_visually_hidden_from_conversation) return false;
      if (message.metadata?.chatgpt_sdk_suppressed_response) return false;
      if (message.metadata?.tool_invoked_message || message.metadata?.tool_invoking_message) return false;
      const text = (message.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
      return Boolean(text);
    });
  const last = messages.at(-1);
  return (last?.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
}

export function deepResearchReportFromConversation(history) {
  const messages = Object.values(history.mapping || {})
    .map((node) => node?.message)
    .filter(Boolean);

  for (const message of messages) {
    const rawState = message.metadata?.chatgpt_sdk?.widget_state;
    if (typeof rawState !== "string") continue;
    try {
      const state = JSON.parse(rawState);
      const text = (state.report_message?.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
      if (text) {
        return {
          text,
          status: state.status || null,
          stoppedAt: state.research_stopped_at || null,
          reportMessageId: state.report_message?.id || null,
        };
      }
    } catch {
      // Ignore unrelated widget state payloads.
    }
  }

  const venusStatus = messages.find((message) => message.metadata?.venus_widget_state)?.metadata?.venus_widget_state?.status || null;
  return { text: "", status: venusStatus, stoppedAt: null, reportMessageId: null };
}

export function findImageAssetPointers(history) {
  const pointers = [];
  const walk = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object") return;
    if (value.content_type === "image_asset_pointer" && typeof value.asset_pointer === "string") {
      pointers.push(value);
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(history);
  return pointers;
}

export async function downloadGeneratedImage({ headers, assetPointer, outPath }) {
  const fileId = assetPointer?.replace(/^sediment:\/\//, "");
  if (!fileId) throw new Error("Missing image asset pointer file id.");
  const download = await fetch(`https://chatgpt.com/backend-api/files/${encodeURIComponent(fileId)}/download`, {
    headers: { ...headers, accept: "application/json" },
  }).then((response) => response.json());
  if (!download.download_url) throw new Error("Image download endpoint did not return download_url.");
  const imageResponse = await fetch(download.download_url, { headers: { ...headers, accept: "image/*,*/*" } });
  const contentType = imageResponse.headers.get("content-type") || "";
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  if (!imageResponse.ok || !contentType.startsWith("image/")) {
    throw new Error(`Image download failed: ${imageResponse.status} ${contentType}`);
  }
  if (outPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, bytes);
  }
  return { bytes, contentType };
}

export async function sendApiMessage({
  prompt,
  curlPath,
  model,
  thinkingEffort,
  attachments = [],
  fetchFinalText = true,
  forceFetchFinalText = false,
  kind = "message",
  quality = "high",
} = {}) {
  if (!prompt) throw new Error("sendApiMessage requires a prompt.");
  const localConfig = loadLocalConfig({ required: !curlPath });
  const template = curlPath ? loadCurlTemplate(curlPath) : null;
  const headers = template ? template.headers : loadLocalHeaders();
  const url = template ? template.url : localConfig.conversationEndpoint || "https://chatgpt.com/backend-api/f/conversation";
  const body = localConfig?.projectUrl
    ? bodyForKind({
        kind,
        quality,
        prompt,
        projectUrl: localConfig.projectUrl,
        model,
        thinkingEffort,
        attachments,
      })
    : prepareMessageBody(JSON.parse(template.bodyRaw), prompt, { model, thinkingEffort, attachments });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      accept: headers.accept || "text/event-stream",
      "content-type": headers["content-type"] || "application/json",
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const streamText = await response.text();
  const stream = parseEventStream(streamText);
  if (fetchFinalText && response.ok && !stream.errorSeen && (forceFetchFinalText || !stream.responseText)) {
    stream.responseText = await fetchLatestAssistantText(headers, stream.conversationId);
  }
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") || "",
    headers,
    ...stream,
  };
}
