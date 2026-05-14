import test from "node:test";
import assert from "node:assert/strict";
import {
  BEST_MODEL_ORDER,
  DEFAULT_REASONING_MODEL,
  DEFAULT_TEXT_MODEL,
  MODEL_PRESETS,
  capabilities,
  modelKey,
  normalizeModelName,
  resolveModelPreset,
} from "../src/model-presets.js";

test("normalizeModelName maps supported aliases to preset names", () => {
  assert.equal(normalizeModelName("default"), "auto");
  assert.equal(normalizeModelName(" ChatGPT "), "auto");
  assert.equal(normalizeModelName("gpt-5.5"), "instant");
  assert.equal(normalizeModelName("gpt 5.5 instant"), "instant");
  assert.equal(normalizeModelName("5.5 thinking"), "thinking");
  assert.equal(normalizeModelName("gpt-5.5-pro"), "pro");
  assert.equal(normalizeModelName("gpt 5.3"), "5.3");
  assert.equal(normalizeModelName("custom-model"), "custom-model");
});

test("resolveModelPreset returns model ids and default reasoning for presets", () => {
  assert.deepEqual(resolveModelPreset({ modelName: "auto" }), {
    model: "auto",
    thinkingEffort: undefined,
    presetName: "auto",
  });
  assert.deepEqual(resolveModelPreset({ modelName: "gpt-5.5" }), {
    model: "gpt-5-5",
    thinkingEffort: undefined,
    presetName: "instant",
  });
  assert.deepEqual(resolveModelPreset({ modelName: "thinking" }), {
    model: "gpt-5-5-thinking",
    thinkingEffort: "standard",
    presetName: "thinking",
  });
  assert.deepEqual(resolveModelPreset({ modelName: "pro" }), {
    model: "gpt-5-5-pro",
    thinkingEffort: "extended",
    presetName: "pro",
  });
});

test("resolveModelPreset honors explicit allowed reasoning", () => {
  assert.deepEqual(resolveModelPreset({ modelName: "thinking", reasoning: "extended" }), {
    model: "gpt-5-5-thinking",
    thinkingEffort: "extended",
    presetName: "thinking",
  });
  assert.deepEqual(resolveModelPreset({ modelName: "pro", reasoning: "standard" }), {
    model: "gpt-5-5-pro",
    thinkingEffort: "standard",
    presetName: "pro",
  });
});

test("resolveModelPreset rejects unsupported reasoning and unknown presets when raw models are disabled", () => {
  assert.throws(() => resolveModelPreset({ modelName: "instant", reasoning: "extended" }), /Supported reasoning: none/);
  assert.throws(() => resolveModelPreset({ modelName: "unknown", allowRawModel: false }), /Unknown model preset/);
});

test("resolveModelPreset passes through raw model ids by default", () => {
  assert.deepEqual(resolveModelPreset({ modelName: "raw-web-model", reasoning: "experimental" }), {
    model: "raw-web-model",
    thinkingEffort: "experimental",
    presetName: null,
  });
  assert.deepEqual(resolveModelPreset(), {});
});

test("modelKey normalizes model aliases and appends reasoning", () => {
  assert.equal(modelKey({ modelName: "gpt-5.5" }), "instant");
  assert.equal(modelKey({ modelName: "5.5 thinking", reasoning: "extended" }), "thinking:extended");
});

test("model preset exports keep expected defaults and best-model order", () => {
  assert.equal(DEFAULT_TEXT_MODEL, "auto");
  assert.equal(DEFAULT_REASONING_MODEL, "thinking");
  assert.equal(MODEL_PRESETS.thinking.defaultReasoning, "standard");
  assert.deepEqual(BEST_MODEL_ORDER[0], { modelName: "pro", reasoning: "extended" });
  assert.deepEqual(BEST_MODEL_ORDER.at(-1), { modelName: "auto" });
});

test("capabilities exposes command, model, default, and readiness shape", () => {
  const data = capabilities();

  assert.equal(data.commands.ask.defaultAsync, true);
  assert.deepEqual(data.commands.ask.kinds, ["message", "image", "deep-research"]);
  assert.equal(data.defaults.messageModel, "auto");
  assert.equal(data.defaults.reasoningModel, "thinking");
  assert.equal(data.models.pro.model, "gpt-5-5-pro");
  assert.equal(typeof data.readiness.message, "boolean");
  assert.equal(typeof data.setup.ready, "boolean");
});
