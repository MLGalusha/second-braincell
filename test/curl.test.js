import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCurl, parseCurl } from "../src/curl.js";

test("normalizeCurl handles common copied cURL line continuations", () => {
  const raw = "curl 'https://chatgpt.com' \\\n  -H 'accept: */*' ^\n  --data-raw '{}'";
  assert.equal(normalizeCurl(raw), "curl 'https://chatgpt.com' -H 'accept: */*' --data-raw '{}'");
});

test("parseCurl extracts URL, method, headers, and JSON body", () => {
  const curl = String.raw`curl 'https://chatgpt.com/backend-api/f/conversation' \
    -H 'Authorization: Bearer test-token' \
    -H 'Content-Type: application/json' \
    -H 'Content-Length: 999' \
    --data-raw '{"conversation_mode":{"gizmo_id":"g-p-abc123"},"messages":[{"content":{"parts":["hi"]}}]}'`;

  const parsed = parseCurl(curl);

  assert.equal(parsed.method, "POST");
  assert.equal(parsed.url, "https://chatgpt.com/backend-api/f/conversation");
  assert.equal(parsed.headers.authorization, "Bearer test-token");
  assert.equal(parsed.headers["content-type"], "application/json");
  assert.equal(parsed.headers["content-length"], undefined);
  assert.equal(JSON.parse(parsed.bodyRaw).conversation_mode.gizmo_id, "g-p-abc123");
});

test("parseCurl preserves unsafe headers when requested", () => {
  const parsed = parseCurl("curl https://chatgpt.com -H 'Host: chatgpt.com' -H 'Content-Length: 12'", {
    dropUnsafeHeaders: false,
  });

  assert.equal(parsed.headers.host, "chatgpt.com");
  assert.equal(parsed.headers["content-length"], "12");
});

test("parseCurl detects file-reference request bodies", () => {
  const parsed = parseCurl("curl -X PUT 'https://upload.example.test/file' --data-binary @fixture.pdf");

  assert.equal(parsed.method, "PUT");
  assert.equal(parsed.bodyRaw, "@fixture.pdf");
  assert.equal(parsed.hasData, true);
  assert.equal(parsed.dataIsFileReference, true);
});
