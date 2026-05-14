import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ROOT_DIR } from "./config.js";
import { applyModelPreset as applyModelPresetArgs } from "./cli-args.js";
import { BEST_MODEL_ORDER, modelKey, normalizeModelName, resolveModelPreset } from "./model-presets.js";
import { ensureDir, readJson, writeJson } from "./util.js";

export const MODEL_CAPABILITIES_PATH = resolve(ROOT_DIR, ".local", "model-capabilities.json");

export function nowIsoForCli() {
  return new Date().toISOString();
}

export function loadModelCapabilities() {
  if (!existsSync(MODEL_CAPABILITIES_PATH)) return null;
  try {
    return readJson(MODEL_CAPABILITIES_PATH);
  } catch {
    return null;
  }
}

export function saveModelCapabilities(data) {
  ensureDir(dirname(MODEL_CAPABILITIES_PATH));
  writeJson(MODEL_CAPABILITIES_PATH, data);
}

export function modelCheckCases({ modelName, reasoning } = {}) {
  if (modelName) {
    const normalized = normalizeModelName(modelName);
    if (normalized === "thinking" || normalized === "pro") {
      const efforts = reasoning ? [reasoning] : ["standard", "extended"];
      return efforts.map((effort) => ({ modelName: normalized, reasoning: effort }));
    }
    return [{ modelName: normalized, reasoning }];
  }
  return [
    { modelName: "auto" },
    { modelName: "instant" },
    { modelName: "thinking", reasoning: "standard" },
    { modelName: "thinking", reasoning: "extended" },
    { modelName: "pro", reasoning: "standard" },
    { modelName: "pro", reasoning: "extended" },
    { modelName: "5.3" },
  ];
}

export function formatModelCheckName(result) {
  return result.reasoning ? `${result.modelName} ${result.reasoning}` : result.modelName;
}

export function resolveBestModelFromResults(results) {
  const byKey = new Map(results.map((result) => [result.key, result]));
  for (const candidate of BEST_MODEL_ORDER) {
    const found = byKey.get(modelKey(candidate));
    if (found?.available) return found;
  }
  return null;
}

export function resolveBestModelFromCache() {
  const cache = loadModelCapabilities();
  const best = cache?.best;
  if (best?.modelName) return { modelName: best.modelName, reasoning: best.reasoning };
  return BEST_MODEL_ORDER[0];
}

export function isModelUnavailableResult(result) {
  return Boolean(result && !result.authExpired && !result.ok && result.status === 422);
}

export function isAuthExpiredResult(result) {
  return Boolean(result?.authExpired || [401, 403].includes(result?.status));
}

function keyForResolvedModel({ modelPreset, thinkingEffort } = {}) {
  return modelKey({ modelName: modelPreset, reasoning: thinkingEffort });
}

export function markModelCapability({ modelPreset, thinkingEffort, model, available, status }) {
  if (!modelPreset) return;
  const cache = loadModelCapabilities() || { results: {} };
  const key = keyForResolvedModel({ modelPreset, thinkingEffort });
  cache.results = cache.results || {};
  cache.results[key] = {
    ...(cache.results[key] || {}),
    modelName: modelPreset,
    reasoning: thinkingEffort || undefined,
    key,
    label: modelPreset,
    model: model || null,
    thinkingEffort: thinkingEffort || null,
    available,
    status,
    checkedAt: nowIsoForCli(),
  };
  cache.checkedAt = nowIsoForCli();
  cache.cachePath = MODEL_CAPABILITIES_PATH;
  cache.best = resolveBestModelFromResults(Object.values(cache.results));
  saveModelCapabilities(cache);
}

export function modelUnavailableMessageForResult(result, { modelPreset, modelSelection } = {}) {
  if (!isModelUnavailableResult(result) || modelPreset !== "pro") return undefined;
  if (modelSelection === "best") {
    return "GPT-5.5 Pro was unavailable for this signed-in ChatGPT account, so best-mode tried the next available checked model.";
  }
  return "GPT-5.5 Pro is not available for this signed-in ChatGPT account. Run `npm run model-check -- --model pro`, change or upgrade the ChatGPT account, or use `--model thinking --reasoning extended`.";
}

export function modelAttemptsForBest(current = {}) {
  const seen = new Set();
  const attempts = [];
  const add = ({ modelName, reasoning }) => {
    const resolved = resolveModelPreset({ modelName, reasoning, allowRawModel: false });
    const key = keyForResolvedModel({ modelPreset: resolved.presetName, thinkingEffort: resolved.thinkingEffort });
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ model: resolved.model, thinkingEffort: resolved.thinkingEffort, modelPreset: resolved.presetName });
  };
  if (current.modelPreset) add({ modelName: current.modelPreset, reasoning: current.thinkingEffort });
  for (const candidate of BEST_MODEL_ORDER) add(candidate);
  return attempts;
}

export function applyModelPreset(argv, options = {}) {
  return applyModelPresetArgs(argv, { resolveBestModel: resolveBestModelFromCache, ...options });
}
