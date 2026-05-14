import test from "node:test";
import assert from "node:assert/strict";

import { formatAlreadyConnected } from "../src/cli-formatters.js";

test("formatAlreadyConnected points users to force reconnect and full status", () => {
  const text = formatAlreadyConnected({
    config: {
      projectId: "g-p-abc123",
      path: "/repo/.local/config.json",
    },
    auth: {
      path: "/repo/.local/auth.json",
    },
  });

  assert.match(text, /already connected/);
  assert.match(text, /Project ID: g-p-abc123/);
  assert.match(text, /npm run connect -- --force/);
  assert.match(text, /npm run capabilities/);
});
