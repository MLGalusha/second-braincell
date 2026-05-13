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

export function prepareMessageBody(body, prompt, { model, thinkingEffort, attachments = [], conversationId, parentMessageId } = {}) {
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
  if (conversationId) next.conversation_id = conversationId;
  if (parentMessageId) next.parent_message_id = parentMessageId;
  next.timezone = next.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  next.timezone_offset_min = new Date().getTimezoneOffset();
  return next;
}

function apiHeaders(headers, accept = "application/json") {
  return { ...headers, accept, "content-type": "application/json" };
}

export function isAuthExpiredStatus(status) {
  return status === 401 || status === 403;
}

export function authRefreshMessage() {
  return "ChatGPT session credentials appear to be expired or unauthorized. Run `npm run connect` and copy a fresh authenticated Project cURL from DevTools.";
}

export class AuthExpiredError extends Error {
  constructor(label, status, detail) {
    super(`${label} failed: ${status}. ${authRefreshMessage()}`);
    this.name = "AuthExpiredError";
    this.code = "CHATGPT_AUTH_EXPIRED";
    this.status = status;
    this.detail = detail;
    this.recoverable = true;
  }
}

async function parseJsonOrThrow(response, label) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (isAuthExpiredStatus(response.status)) throw new AuthExpiredError(label, response.status, text);
    throw new Error(`${label} returned non-JSON response: ${response.status}`);
  }
  if (isAuthExpiredStatus(response.status)) throw new AuthExpiredError(label, response.status, json);
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function fetchJsonOrThrow(url, options, label) {
  const response = await fetch(url, options);
  return parseJsonOrThrow(response, label);
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
  if (isAuthExpiredStatus(processResponse.status)) throw new AuthExpiredError("process upload", processResponse.status, processText);
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

function findConversationId(value, depth = 0) {
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
}

function parseEventLine(line, state) {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") {
    state.finishSeen = true;
    return;
  }
  if (!payload) return;
  try {
    const json = JSON.parse(payload);
    const type = json.type || json.event || "json";
    state.eventTypes.set(type, (state.eventTypes.get(type) || 0) + 1);
    if (json.error || type === "error") state.errorSeen = true;
    state.conversationId = state.conversationId || findConversationId(json);
    state.chunks.push(...extractTextFromJson(json));
  } catch {
    state.eventTypes.set("non-json", (state.eventTypes.get("non-json") || 0) + 1);
  }
}

async function readEventStreamUntilConversationId(response, { timeoutMs = 8000 } = {}) {
  if (!response.body) return parseEventStream(await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = {
    chunks: [],
    eventTypes: new Map(),
    errorSeen: false,
    finishSeen: false,
    conversationId: null,
  };
  let buffer = "";
  const timeout = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) parseEventLine(line, state);
      if (state.conversationId || state.errorSeen) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    buffer += decoder.decode();
    if (buffer) parseEventLine(buffer, state);
  } catch {
    // A timeout/cancel after the server accepted the request is enough for async submit.
  } finally {
    clearTimeout(timeout);
  }
  const meaningful = state.chunks.filter((chunk) => chunk && !/^(finished_successfully|finished_partial_completion)$/.test(chunk.trim()));
  return {
    responseText: meaningful.at(-1) || meaningful.join("").trim(),
    conversationId: state.conversationId,
    finishSeen: state.finishSeen,
    errorSeen: state.errorSeen,
    eventTypes: Object.fromEntries([...state.eventTypes.entries()].sort()),
  };
}

export function projectIdFromUrl(url = loadLocalConfig({ required: false })?.projectUrl || process.env.CHATGPT_PROJECT_URL || "") {
  return url.match(/\/g\/(g-p-[a-z0-9]+)(?:-|\/|$)/i)?.[1] || null;
}

export async function listProjectConversations(headers, { limit = 20 } = {}) {
  const projectId = projectIdFromUrl();
  if (!projectId) throw new Error("No ChatGPT Project ID configured. Run `npm run connect` first.");
  return listConversationsForProject(headers, projectId, { limit });
}

export async function listConversationsForProject(headers, projectId, { limit = 20 } = {}) {
  const jsonHeaders = { ...headers, accept: "application/json" };
  const items = [];
  let cursor = "0";
  while (items.length < limit && cursor !== null && cursor !== undefined) {
    const list = await fetchJsonOrThrow(
      `https://chatgpt.com/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=${encodeURIComponent(cursor)}`,
      { headers: jsonHeaders },
      "List project conversations",
    );
    items.push(...(list.items || []));
    if (!list.cursor || list.cursor === cursor) break;
    cursor = list.cursor;
  }
  return items.slice(0, limit);
}

export async function listAllConversations(headers, { limit = 20, offset = 0 } = {}) {
  const jsonHeaders = { ...headers, accept: "application/json" };
  const response = await fetch(
    `https://chatgpt.com/backend-api/conversations?offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}&order=updated`,
    { headers: jsonHeaders },
  );
  const json = await parseJsonOrThrow(response, "List conversations");
  return (json.items || []).slice(0, limit);
}

export async function searchConversations(headers, { query, limit = 10, projectId } = {}) {
  if (!query) throw new Error("Search query is required.");
  const params = new URLSearchParams({ query, limit: String(limit) });
  if (projectId) params.set("conversation_template_id", projectId);
  const response = await fetch(`https://chatgpt.com/backend-api/conversations/search?${params.toString()}`, {
    headers: { ...headers, accept: "application/json" },
  });
  const json = await parseJsonOrThrow(response, "Search conversations");
  return (json.items || []).slice(0, limit);
}

export async function fetchProjectResource(headers, projectId = projectIdFromUrl()) {
  if (!projectId) throw new Error("No ChatGPT Project ID configured. Run `npm run connect` first.");
  const response = await fetch(`https://chatgpt.com/backend-api/gizmos/${encodeURIComponent(projectId)}`, {
    headers: { ...headers, accept: "application/json" },
  });
  return parseJsonOrThrow(response, "Fetch project");
}

function projectSharingForUpsert(gizmo) {
  const subjects = gizmo.sharing?.subjects || [];
  if (!subjects.length) {
    return [
      {
        type: "private",
        capabilities: {
          can_read: true,
          can_view_config: false,
          can_write: false,
          can_delete: false,
          can_export: false,
          can_share: false,
        },
      },
    ];
  }
  return subjects;
}

export function projectUpsertBodyFromResource(resource, patch = {}) {
  const gizmo = resource.gizmo || {};
  const display = gizmo.display || {};
  return {
    gizmo_id: gizmo.id,
    instructions: patch.instructions ?? gizmo.instructions ?? "",
    display: {
      name: patch.name ?? display.name ?? "Project",
      description: patch.description ?? display.description ?? "",
      emoji: patch.emoji ?? display.emoji ?? undefined,
      theme: patch.theme ?? display.theme ?? undefined,
      profile_pic_id: patch.profilePicId ?? display.profile_pic_id ?? undefined,
      profile_picture_url: patch.profilePictureUrl ?? display.profile_picture_url ?? undefined,
      prompt_starters: patch.promptStarters ?? display.prompt_starters ?? [],
    },
    tools: [],
    memory_scope: patch.memoryScope ?? gizmo.memory_scope ?? "project_v2",
    files: (resource.files || []).map(({ metadata, ...file }) => ({ ...file, location: "file_service" })),
    training_disabled: patch.trainingDisabled ?? gizmo.training_disabled ?? false,
    sharing: projectSharingForUpsert(gizmo),
    categories: undefined,
  };
}

export async function updateProjectInstructions(headers, { projectId = projectIdFromUrl(), instructions } = {}) {
  if (typeof instructions !== "string") throw new Error("instructions must be a string.");
  const resource = await fetchProjectResource(headers, projectId);
  const body = projectUpsertBodyFromResource(resource, { instructions });
  const response = await fetch("https://chatgpt.com/backend-api/gizmos/snorlax/upsert", {
    method: "POST",
    headers: apiHeaders(headers),
    body: JSON.stringify(body),
  });
  const json = await parseJsonOrThrow(response, "Update project instructions");
  if (json.error) throw new Error(`Update project instructions failed: ${response.status} ${JSON.stringify(json)}`);
  return { before: resource, result: json };
}

export async function fetchLatestAssistantText(headers, conversationId) {
  let id = conversationId;
  const jsonHeaders = { ...headers, accept: "application/json" };
  if (!id) {
    const projectId = projectIdFromUrl();
    if (!projectId) return "";
    const list = await fetchJsonOrThrow(
      `https://chatgpt.com/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=0`,
      { headers: jsonHeaders },
      "List project conversations",
    );
    id = list.items?.[0]?.id;
  }
  if (!id) return "";
  const history = await fetchJsonOrThrow(
    `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`,
    { headers: jsonHeaders },
    "Fetch conversation",
  );
  const messages = Object.values(history.mapping || {})
    .map((node) => node?.message)
    .filter((message) => message?.author?.role === "assistant");
  const last = messages.at(-1);
  return (last?.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
}

export async function fetchConversation(headers, conversationId) {
  return fetchJsonOrThrow(
    `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`,
    { headers: { ...headers, accept: "application/json" } },
    "Fetch conversation",
  );
}

export function latestConversationNodeId(history) {
  if (typeof history?.current_node === "string" && history.current_node) return history.current_node;
  const mapping = history?.mapping || {};
  const leaf = Object.entries(mapping).find(([, node]) => Array.isArray(node?.children) && node.children.length === 0);
  if (leaf?.[0]) return leaf[0];
  const messages = Object.entries(mapping)
    .map(([id, node]) => ({ id, message: node?.message }))
    .filter(({ message }) => message?.id || message?.author?.role)
    .sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
  return messages.at(-1)?.id || null;
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
  const download = await fetchJsonOrThrow(
    `https://chatgpt.com/backend-api/files/${encodeURIComponent(fileId)}/download`,
    { headers: { ...headers, accept: "application/json" } },
    "Image download URL",
  );
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
  conversationId,
  parentMessageId,
  fetchFinalText = true,
  forceFetchFinalText = false,
  kind = "message",
  quality = "high",
  submitOnly = false,
} = {}) {
  if (!prompt) throw new Error("sendApiMessage requires a prompt.");
  const localConfig = loadLocalConfig({ required: !curlPath });
  const template = curlPath ? loadCurlTemplate(curlPath) : null;
  const headers = template ? template.headers : loadLocalHeaders();
  const url = template ? template.url : localConfig.conversationEndpoint || "https://chatgpt.com/backend-api/f/conversation";
  if (conversationId && !parentMessageId) {
    const history = await fetchConversation(headers, conversationId);
    parentMessageId = latestConversationNodeId(history);
    if (!parentMessageId) throw new Error(`Could not find latest message id for conversation ${conversationId}.`);
  }
  const body = localConfig?.projectUrl
    ? bodyForKind({
        kind,
        quality,
        prompt,
        projectUrl: localConfig.projectUrl,
        model,
        thinkingEffort,
        attachments,
        conversationId,
        parentMessageId,
      })
    : prepareMessageBody(JSON.parse(template.bodyRaw), prompt, { model, thinkingEffort, attachments, conversationId, parentMessageId });
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
  const contentType = response.headers.get("content-type") || "";
  if (isAuthExpiredStatus(response.status)) {
    return {
      status: response.status,
      ok: false,
      contentType,
      headers,
      responseText: "",
      conversationId: null,
      finishSeen: false,
      errorSeen: true,
      authExpired: true,
      message: authRefreshMessage(),
      eventTypes: {},
    };
  }
  const stream = submitOnly && response.ok ? await readEventStreamUntilConversationId(response) : parseEventStream(await response.text());
  if (fetchFinalText && response.ok && !stream.errorSeen && (forceFetchFinalText || !stream.responseText)) {
    stream.responseText = await fetchLatestAssistantText(headers, stream.conversationId);
  }
  return {
    status: response.status,
    ok: response.ok,
    contentType,
    headers,
    ...stream,
  };
}
