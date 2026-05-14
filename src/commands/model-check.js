import { authRefreshMessage, fetchConversation, latestAssistantTextFromConversation, sendApiMessage } from "../chatgpt-api.js";
import { color } from "../cli-ui.js";
import { loadLocalHeaders } from "../local-config.js";
import { resolveModelPreset, modelKey } from "../model-presets.js";
import { getFlag, hasFlag } from "../util.js";
import {
  formatModelCheckName,
  isAuthExpiredResult,
  loadModelCapabilities,
  MODEL_CAPABILITIES_PATH,
  modelCheckCases,
  nowIsoForCli,
  resolveBestModelFromResults,
  saveModelCapabilities,
} from "../model-capabilities.js";

async function waitForAssistantText(headers, conversationId, { expected, timeoutMs = 20000, intervalMs = 1500 } = {}) {
  if (!conversationId) return "";
  const started = Date.now();
  let latest = "";
  while (Date.now() - started < timeoutMs) {
    const history = await fetchConversation(headers, conversationId);
    latest = latestAssistantTextFromConversation(history);
    if (latest && (!expected || latest.includes(expected))) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  return latest;
}

async function runSingleModelCheck(testCase, headers) {
  const resolved = resolveModelPreset({ modelName: testCase.modelName, reasoning: testCase.reasoning, allowRawModel: false });
  const key = modelKey(testCase);
  const expected = `MODEL_CHECK_${key.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_OK`;
  const checkedAt = nowIsoForCli();
  try {
    const result = await sendApiMessage({
      prompt: `Reply with exactly: ${expected}`,
      model: resolved.model,
      thinkingEffort: resolved.thinkingEffort,
      fetchFinalText: true,
      forceFetchFinalText: true,
      kind: "message",
    });
    if (isAuthExpiredResult(result)) {
      return {
        ...testCase,
        key,
        label: resolved.presetName,
        model: resolved.model || null,
        thinkingEffort: resolved.thinkingEffort || null,
        available: false,
        authExpired: true,
        status: result.status,
        error: result.message || authRefreshMessage(),
        checkedAt,
      };
    }
    let responseText = result.responseText || "";
    if (result.ok && (!responseText || !responseText.includes(expected))) {
      responseText = await waitForAssistantText(headers, result.conversationId, { expected });
    }
    const matched = responseText.trim() === expected;
    return {
      ...testCase,
      key,
      label: resolved.presetName,
      model: resolved.model || null,
      thinkingEffort: resolved.thinkingEffort || null,
      available: Boolean(result.ok && matched),
      status: result.status,
      contentType: result.contentType,
      responseMatched: matched,
      responseLength: responseText.length,
      checkedAt,
    };
  } catch (error) {
    return {
      ...testCase,
      key,
      label: resolved.presetName,
      model: resolved.model || null,
      thinkingEffort: resolved.thinkingEffort || null,
      available: false,
      error: error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  }
}

function formatModelCheck(results, path, best = resolveBestModelFromResults(results)) {
  const lines = [color("1;36", "Second Braincell Model Check"), ""];
  for (const result of results) {
    const marker = result.available ? color("32", "available") : color("31", "unavailable");
    const detail = result.authExpired ? result.error : result.status ? `HTTP ${result.status}` : result.error || "not checked";
    lines.push(`${formatModelCheckName(result)}: ${marker} (${detail})`);
  }
  if (best) {
    lines.push("");
    lines.push(`best: ${formatModelCheckName(best)}`);
  }
  lines.push("");
  lines.push(`Cache: ${path}`);
  return lines.join("\n");
}

export async function runModelCheck(argv) {
  const cases = modelCheckCases({
    modelName: getFlag(argv, "--model", undefined),
    reasoning: getFlag(argv, "--reasoning", getFlag(argv, "--thinking-effort", undefined)),
  });
  const headers = loadLocalHeaders();
  const results = [];
  for (const testCase of cases) {
    const result = await runSingleModelCheck(testCase, headers);
    results.push(result);
    if (result.authExpired) break;
  }
  const previous = loadModelCapabilities();
  const mergedResults = { ...(previous?.results || {}) };
  for (const result of results) mergedResults[result.key] = result;
  const payload = {
    checkedAt: nowIsoForCli(),
    cachePath: MODEL_CAPABILITIES_PATH,
    results: mergedResults,
    best: resolveBestModelFromResults(Object.values(mergedResults)),
  };
  saveModelCapabilities(payload);
  if (hasFlag(argv, "--json") || hasFlag(argv, "--detailed")) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatModelCheck(results, MODEL_CAPABILITIES_PATH, payload.best));
  }
}
