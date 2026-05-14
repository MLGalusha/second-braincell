import test from "node:test";
import assert from "node:assert/strict";
import { parseEventStream, parseUploadProcessStream, prepareMessageBody } from "../src/chatgpt-api.js";

test("prepareMessageBody rewrites prompt and continuation fields without mutating template", () => {
  const template = {
    model: "old-model",
    messages: [
      {
        id: "old-id",
        content: { content_type: "text", parts: ["old prompt"] },
        metadata: { timestamp_: "remove-me" },
      },
    ],
  };

  const next = prepareMessageBody(template, "new prompt", {
    model: "new-model",
    thinkingEffort: "standard",
    conversationId: "conv_123",
    parentMessageId: "parent_123",
    attachments: [{ id: "file-1", size: 5, name: "a.txt", fileTokenSize: 2 }],
  });

  assert.deepEqual(template.messages[0].content.parts, ["old prompt"]);
  assert.deepEqual(next.messages[0].content.parts, ["new prompt"]);
  assert.equal(next.model, "new-model");
  assert.equal(next.thinking_effort, "standard");
  assert.equal(next.conversation_id, "conv_123");
  assert.equal(next.parent_message_id, "parent_123");
  assert.equal(next.messages[0].metadata.timestamp_, undefined);
  assert.equal(next.messages[0].metadata.attachments[0].id, "file-1");
});

test("parseEventStream extracts assistant text and conversation id from SSE data", () => {
  const stream = [
    'data: {"type":"conversation_detail","conversation_id":"conv_123456789"}',
    'data: {"type":"message","message":{"author":{"role":"assistant"},"content":{"parts":["hello"]}}}',
    "data: [DONE]",
    "",
  ].join("\n");

  const parsed = parseEventStream(stream);

  assert.equal(parsed.responseText, "hello");
  assert.equal(parsed.conversationId, "conv_123456789");
  assert.equal(parsed.finishSeen, true);
  assert.equal(parsed.errorSeen, false);
  assert.equal(parsed.eventTypes.conversation_detail, 1);
  assert.equal(parsed.eventTypes.message, 1);
});

test("parseEventStream reports non-json and error events", () => {
  const parsed = parseEventStream(['data: {"type":"error","error":{"message":"bad"}}', "data: not-json"].join("\n"));

  assert.equal(parsed.errorSeen, true);
  assert.equal(parsed.eventTypes.error, 1);
  assert.equal(parsed.eventTypes["non-json"], 1);
});

test("parseUploadProcessStream returns parsed events and latest final event", () => {
  const parsed = parseUploadProcessStream(
    ['data: {"status":"processing"}', 'data: {"status":"done","file_token_size":12}', "data: [DONE]"].join("\n"),
  );

  assert.equal(parsed.events.length, 2);
  assert.deepEqual(parsed.final, { status: "done", file_token_size: 12 });
});
