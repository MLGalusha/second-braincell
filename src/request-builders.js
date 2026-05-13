import { randomUUID } from "node:crypto";
import { projectIdFromProjectUrl } from "./local-config.js";

const DEFAULT_CONTEXT = {
  is_dark_mode: false,
  time_since_loaded: 1,
  page_height: 900,
  page_width: 1200,
  pixel_ratio: 1,
  screen_height: 900,
  screen_width: 1200,
  app_name: "chatgpt.com",
};

function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function attachmentMetadata(attachments = []) {
  return attachments.map((attachment) => ({
    id: attachment.id,
    size: attachment.size,
    name: attachment.name,
    mime_type: attachment.mimeType,
    file_token_size: attachment.fileTokenSize ?? 0,
    source: attachment.source || "upload",
    is_big_paste: false,
  }));
}

function baseMetadata({ attachments = [], systemHints = [], extraMetadata = {} } = {}) {
  const metadata = {
    developer_mode_connector_ids: [],
    selected_sources: [],
    selected_github_repos: [],
    selected_all_github_repos: false,
    serialization_metadata: { custom_symbol_offsets: [] },
    ...extraMetadata,
  };
  if (systemHints.length) metadata.system_hints = systemHints;
  if (attachments.length) metadata.attachments = attachmentMetadata(attachments);
  return metadata;
}

export function buildConversationBody({
  prompt,
  projectUrl,
  model,
  thinkingEffort,
  attachments = [],
  systemHints = [],
  extraMetadata = {},
  conversationId,
  parentMessageId,
} = {}) {
  if (!prompt) throw new Error("A prompt is required.");
  const projectId = projectIdFromProjectUrl(projectUrl);
  if (!projectId) throw new Error("Missing ChatGPT project id. Run `npm run setup` with a valid project URL.");
  const body = {
    action: "next",
    messages: [
      {
        id: randomUUID(),
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content: {
          content_type: "text",
          parts: [prompt],
        },
        metadata: baseMetadata({ attachments, systemHints, extraMetadata }),
      },
    ],
    parent_message_id: parentMessageId || "client-created-root",
    model,
    client_prepare_state: "sent",
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: timezone(),
    conversation_mode: {
      kind: "gizmo_interaction",
      gizmo_id: projectId,
    },
    enable_message_followups: true,
    system_hints: systemHints,
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: DEFAULT_CONTEXT,
    paragen_cot_summary_display_override: "allow",
    force_parallel_switch: "auto",
  };
  if (conversationId) body.conversation_id = conversationId;
  if (thinkingEffort) body.thinking_effort = thinkingEffort;
  return body;
}

export function buildMessageBody(options = {}) {
  return buildConversationBody({ ...options, model: options.model || "gpt-5-3" });
}

export function buildImageHighBody(options = {}) {
  return buildConversationBody({
    ...options,
    model: options.model || "gpt-5-5-thinking",
    thinkingEffort: options.thinkingEffort || "standard",
    systemHints: ["picture_v2"],
  });
}

export function buildImageInstantBody(options = {}) {
  return buildConversationBody({
    ...options,
    model: options.model || "gpt-5-5",
    thinkingEffort: undefined,
    systemHints: ["picture_v2"],
  });
}

export function buildDeepResearchBody(options = {}) {
  const tz = timezone();
  return buildConversationBody({
    ...options,
    model: options.model || "gpt-5-5-thinking",
    thinkingEffort: options.thinkingEffort || "standard",
    systemHints: ["connector:connector_openai_deep_research"],
    extraMetadata: {
      caterpillar_selected_sources: ["web"],
      selected_mcp_sources: [],
      selected_sources: ["web"],
      deep_research_version: "standard",
      venus_model_variant: "standard",
      user_timezone: tz,
    },
  });
}

export function buildAttachmentMetadataBody(attachment) {
  return attachmentMetadata([attachment])[0];
}

export function bodyForKind({ kind = "message", quality = "high", ...options } = {}) {
  if (kind === "image") return quality === "instant" ? buildImageInstantBody(options) : buildImageHighBody(options);
  if (kind === "deep-research") return buildDeepResearchBody(options);
  return buildMessageBody(options);
}
