import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProjectUrl,
  projectIdFromCurl,
  projectIdFromProjectUrl,
  projectUrlFromProjectId,
  validateAuthCurl,
} from "../src/local-config.js";
import { parseCurl } from "../src/curl.js";

test("project URL helpers normalize and extract ChatGPT Project IDs", () => {
  assert.equal(projectIdFromProjectUrl("https://chatgpt.com/g/g-p-abc123-project-name"), "g-p-abc123");
  assert.equal(projectUrlFromProjectId("g-p-abc123"), "https://chatgpt.com/g/g-p-abc123");
  assert.equal(normalizeProjectUrl("https://chatgpt.com/g/g-p-abc123-project-name#section"), "https://chatgpt.com/g/g-p-abc123-project-name");
});

test("projectIdFromCurl finds project id in body and referer", () => {
  const fromBody = parseCurl(
    "curl 'https://chatgpt.com/backend-api/f/conversation' --data-raw '{\"conversation_mode\":{\"gizmo_id\":\"g-p-body123\"}}'",
  );
  const fromReferer = parseCurl("curl 'https://chatgpt.com/backend-api/f/conversation' -H 'Referer: https://chatgpt.com/g/g-p-ref123-name'");

  assert.equal(projectIdFromCurl(fromBody), "g-p-body123");
  assert.equal(projectIdFromCurl(fromReferer), "g-p-ref123");
});

test("validateAuthCurl accepts authenticated ChatGPT cURLs and strips unsafe headers", () => {
  const parsed = validateAuthCurl(
    "curl 'https://chatgpt.com/backend-api/f/conversation' -H 'Authorization: Bearer test-token' -H 'Host: chatgpt.com'",
  );

  assert.equal(parsed.url, "https://chatgpt.com/backend-api/f/conversation");
  assert.equal(parsed.headers.authorization, "Bearer test-token");
  assert.equal(parsed.headers.host, undefined);
});

test("validateAuthCurl rejects unauthenticated or non-ChatGPT cURLs", () => {
  assert.throws(() => validateAuthCurl("curl 'https://example.com' -H 'Authorization: Bearer test-token'"), /chatgpt\.com/);
  assert.throws(() => validateAuthCurl("curl 'https://chatgpt.com/backend-api/f/conversation'"), /Authorization or Cookie/);
});
