import test from "node:test";
import assert from "node:assert/strict";

import { applyModelPreset, ensureFlag, firstPositionalArg, firstPositionalIndex, normalizeAskArgv, splitSelectorArg, withoutFlags } from "../src/cli-args.js";

test("withoutFlags removes value flags and leaves unrelated args in order", () => {
  assert.deepEqual(
    withoutFlags(["--kind", "image", "--prompt", "draw it", "--async", "--watch", "selector"], ["--kind", "--prompt"]),
    ["--async", "--watch", "selector"],
  );
});

test("withoutFlags removes boolean flags without swallowing the next flag", () => {
  assert.deepEqual(withoutFlags(["--sync", "--kind", "message", "--json"], ["--sync", "--kind"]), ["--json"]);
});

test("ensureFlag appends missing boolean and value flags", () => {
  assert.deepEqual(ensureFlag(["--json"], "--watch"), ["--json", "--watch"]);
  assert.deepEqual(ensureFlag(["--json"], "--limit", 5), ["--json", "--limit", "5"]);
});

test("ensureFlag preserves existing flags and values", () => {
  assert.deepEqual(ensureFlag(["--limit", "10"], "--limit", 5), ["--limit", "10"]);
});

test("firstPositionalIndex skips known value flags", () => {
  const argv = ["--search", "release notes", "--limit", "5", "conv_123", "--json"];
  assert.equal(firstPositionalIndex(argv), 4);
  assert.equal(firstPositionalArg(argv), "conv_123");
});

test("firstPositionalArg ignores option-only argv", () => {
  assert.equal(firstPositionalArg(["--search", "release notes", "--json"]), undefined);
});

test("splitSelectorArg returns selector and removes only that positional arg", () => {
  assert.deepEqual(splitSelectorArg(["--limit", "5", "2", "--json"], "resume"), {
    selector: "2",
    rest: ["--limit", "5", "--json"],
  });
});

test("splitSelectorArg reports the command that needs a selector", () => {
  assert.throws(() => splitSelectorArg(["--limit", "5"], "transcript"), /transcript requires a chat number/);
});

test("applyModelPreset converts default model to explicit ChatGPT model args", () => {
  assert.deepEqual(applyModelPreset(["--prompt", "hi"]), ["--prompt", "hi", "--model", "auto", "--model-preset", "auto"]);
});

test("applyModelPreset normalizes model aliases and reasoning flags", () => {
  assert.deepEqual(applyModelPreset(["--model", "5.5 thinking", "--reasoning", "extended"]), [
    "--model",
    "gpt-5-5-thinking",
    "--thinking-effort",
    "extended",
    "--model-preset",
    "thinking",
  ]);
});

test("applyModelPreset treats --thinking-effort like --reasoning", () => {
  assert.deepEqual(applyModelPreset(["--model", "pro", "--thinking-effort", "standard"]), [
    "--model",
    "gpt-5-5-pro",
    "--thinking-effort",
    "standard",
    "--model-preset",
    "pro",
  ]);
});

test("applyModelPreset resolves best through injected cache lookup", () => {
  assert.deepEqual(
    applyModelPreset(["--model", "best"], {
      resolveBestModel: () => ({ modelName: "thinking", reasoning: "extended" }),
    }),
    ["--model", "gpt-5-5-thinking", "--thinking-effort", "extended", "--model-preset", "thinking", "--model-selection", "best"],
  );
});

test("applyModelPreset leaves raw model names available", () => {
  assert.deepEqual(applyModelPreset(["--model", "custom-model", "--reasoning", "medium"]), [
    "--model",
    "custom-model",
    "--thinking-effort",
    "medium",
  ]);
});

test("applyModelPreset rejects unsupported reasoning for presets", () => {
  assert.throws(() => applyModelPreset(["--model", "instant", "--reasoning", "extended"]), /instant does not support reasoning/);
});

test("normalizeAskArgv applies text defaults for message asks", () => {
  assert.deepEqual(normalizeAskArgv(["--prompt", "hi"]), ["--prompt", "hi", "--model", "auto", "--model-preset", "auto"]);
});

test("normalizeAskArgv gives image asks async watcher defaults and strips model hints", () => {
  assert.deepEqual(normalizeAskArgv(["--kind", "image", "--prompt", "draw", "--model", "pro", "--quality", "instant"]), [
    "--prompt",
    "draw",
    "--async",
    "--watch",
    "--watch-interval-seconds",
    "30",
    "--watch-timeout-seconds",
    "300",
    "--job-kind",
    "api-image",
    "--output-kind",
    "image",
    "--kind",
    "image",
    "--quality",
    "instant",
  ]);
});

test("normalizeAskArgv lets --sync suppress async defaults for image asks", () => {
  assert.deepEqual(normalizeAskArgv(["--kind", "image", "--sync", "--prompt", "draw"]), [
    "--prompt",
    "draw",
    "--job-kind",
    "api-image",
    "--output-kind",
    "image",
    "--kind",
    "image",
    "--quality",
    "high",
  ]);
});

test("normalizeAskArgv gives deep research asks long watcher defaults", () => {
  assert.deepEqual(normalizeAskArgv(["--kind", "deep-research", "--prompt", "research"]), [
    "--prompt",
    "research",
    "--async",
    "--watch",
    "--watch-interval-seconds",
    "300",
    "--watch-timeout-seconds",
    "7200",
    "--job-kind",
    "api-deep-research",
    "--kind",
    "deep-research",
  ]);
});

test("normalizeAskArgv preserves explicit deep research model hints", () => {
  assert.deepEqual(normalizeAskArgv(["--kind", "deep-research", "--prompt", "research", "--model", "thinking", "--reasoning", "extended"]), [
    "--prompt",
    "research",
    "--async",
    "--watch",
    "--watch-interval-seconds",
    "300",
    "--watch-timeout-seconds",
    "7200",
    "--model",
    "gpt-5-5-thinking",
    "--thinking-effort",
    "extended",
    "--model-preset",
    "thinking",
    "--job-kind",
    "api-deep-research",
    "--kind",
    "deep-research",
  ]);
});

test("normalizeAskArgv rejects unknown ask kinds", () => {
  assert.throws(() => normalizeAskArgv(["--kind", "video"]), /--kind must be message, image, or deep-research/);
});
