import test from "node:test";
import assert from "node:assert/strict";
import {
  bodyForKind,
  buildAttachmentMetadataBody,
  buildConversationBody,
  buildDeepResearchBody,
  buildImageHighBody,
  buildImageInstantBody,
} from "../src/request-builders.js";

const projectUrl = "https://chatgpt.com/g/g-p-abc123";

test("buildConversationBody creates a project-scoped user message", () => {
  const body = buildConversationBody({
    prompt: "Hello",
    projectUrl,
    model: "auto",
    conversationId: "conv_123",
    parentMessageId: "parent_123",
    attachments: [{ id: "file-123", size: 42, name: "doc.pdf", mimeType: "application/pdf", fileTokenSize: 7 }],
  });

  assert.equal(body.action, "next");
  assert.equal(body.model, "auto");
  assert.equal(body.conversation_id, "conv_123");
  assert.equal(body.parent_message_id, "parent_123");
  assert.deepEqual(body.messages[0].content.parts, ["Hello"]);
  assert.equal(body.conversation_mode.kind, "gizmo_interaction");
  assert.equal(body.conversation_mode.gizmo_id, "g-p-abc123");
  assert.deepEqual(body.messages[0].metadata.attachments[0], {
    id: "file-123",
    size: 42,
    name: "doc.pdf",
    mime_type: "application/pdf",
    file_token_size: 7,
    source: "upload",
    is_big_paste: false,
  });
});

test("image and deep research builders set expected model hints", () => {
  const imageHigh = buildImageHighBody({ prompt: "Draw", projectUrl });
  const imageInstant = buildImageInstantBody({ prompt: "Draw fast", projectUrl });
  const deepResearch = buildDeepResearchBody({ prompt: "Research", projectUrl });

  assert.equal(imageHigh.model, "gpt-5-5-thinking");
  assert.equal(imageHigh.thinking_effort, "standard");
  assert.deepEqual(imageHigh.system_hints, ["picture_v2"]);
  assert.equal(imageInstant.model, "gpt-5-5");
  assert.equal(imageInstant.thinking_effort, undefined);
  assert.deepEqual(imageInstant.system_hints, ["picture_v2"]);
  assert.deepEqual(deepResearch.system_hints, ["connector:connector_openai_deep_research"]);
  assert.equal(deepResearch.messages[0].metadata.deep_research_version, "standard");
});

test("bodyForKind dispatches to the expected builder", () => {
  assert.deepEqual(bodyForKind({ kind: "image", quality: "instant", prompt: "x", projectUrl }).system_hints, ["picture_v2"]);
  assert.equal(bodyForKind({ kind: "deep-research", prompt: "x", projectUrl }).messages[0].metadata.venus_model_variant, "standard");
  assert.equal(bodyForKind({ kind: "message", prompt: "x", projectUrl }).conversation_mode.gizmo_id, "g-p-abc123");
});

test("buildAttachmentMetadataBody returns ChatGPT attachment metadata shape", () => {
  assert.deepEqual(buildAttachmentMetadataBody({ id: "file-1", size: 10, name: "a.txt", mimeType: "text/plain" }), {
    id: "file-1",
    size: 10,
    name: "a.txt",
    mime_type: "text/plain",
    file_token_size: 0,
    source: "upload",
    is_big_paste: false,
  });
});

test("buildConversationBody requires prompt and project id", () => {
  assert.throws(() => buildConversationBody({ projectUrl }), /prompt is required/i);
  assert.throws(() => buildConversationBody({ prompt: "Hello", projectUrl: "https://chatgpt.com" }), /project id/i);
});
