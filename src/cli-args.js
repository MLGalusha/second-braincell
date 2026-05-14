import { getFlag } from "./util.js";
import { DEFAULT_TEXT_MODEL, normalizeModelName, resolveModelPreset } from "./model-presets.js";

export const VALUE_FLAGS = new Set([
  "--prompt",
  "--prompt-file",
  "--file",
  "--curl",
  "--curl-file",
  "--project-url",
  "--model",
  "--reasoning",
  "--thinking-effort",
  "--kind",
  "--quality",
  "--attach-file",
  "--continue-job",
  "--conversation-id",
  "--parent-message-id",
  "--transcript",
  "--out",
  "--limit",
  "--max-turns",
  "--project",
  "--search",
  "--query",
  "--set",
  "--set-file",
  "--watch-interval-seconds",
  "--watch-timeout-seconds",
  "--max-messages",
  "--max-chars",
  "--job-kind",
  "--output-kind",
  "--model-preset",
  "--model-selection",
]);

export function withoutFlags(argv, names) {
  const drop = new Set(names);
  const next = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (!drop.has(argv[i])) {
      next.push(argv[i]);
      continue;
    }
    if (i + 1 < argv.length && !String(argv[i + 1]).startsWith("--")) i += 1;
  }
  return next;
}

export function ensureFlag(argv, name, value = null) {
  if (argv.includes(name)) return argv;
  return value === null ? [...argv, name] : [...argv, name, String(value)];
}

export function applyModelPreset(argv, { defaultModel = DEFAULT_TEXT_MODEL, resolveBestModel } = {}) {
  let requestedModel = getFlag(argv, "--model", defaultModel);
  let requestedReasoning = getFlag(argv, "--reasoning", getFlag(argv, "--thinking-effort", undefined));
  const requestedWasBest = normalizeModelName(requestedModel) === "best";
  if (requestedWasBest) {
    const best = resolveBestModel?.();
    requestedModel = best?.modelName || DEFAULT_TEXT_MODEL;
    requestedReasoning = requestedReasoning || best?.reasoning;
  }
  const resolved = resolveModelPreset({ modelName: requestedModel, reasoning: requestedReasoning });
  let next = withoutFlags(argv, ["--model", "--reasoning", "--thinking-effort"]);
  if (resolved.model) next = ensureFlag(next, "--model", resolved.model);
  if (resolved.thinkingEffort) next = ensureFlag(next, "--thinking-effort", resolved.thinkingEffort);
  if (resolved.presetName) next = ensureFlag(next, "--model-preset", resolved.presetName);
  if (requestedWasBest) next = ensureFlag(next, "--model-selection", "best");
  return next;
}

export function normalizeAskArgv(argv, { resolveBestModel } = {}) {
  const kind = getFlag(argv, "--kind", "message");
  if (!["message", "image", "deep-research"].includes(kind)) throw new Error("--kind must be message, image, or deep-research");

  const asyncByDefault = kind !== "message" && !argv.includes("--sync");
  let nextArgv = withoutFlags(argv, ["--kind", "--sync"]);

  if (asyncByDefault) {
    nextArgv = ensureFlag(nextArgv, "--async");
    nextArgv = ensureFlag(nextArgv, "--watch");
    if (kind === "image") {
      nextArgv = ensureFlag(nextArgv, "--watch-interval-seconds", "30");
      nextArgv = ensureFlag(nextArgv, "--watch-timeout-seconds", "300");
    }
    if (kind === "deep-research") {
      nextArgv = ensureFlag(nextArgv, "--watch-interval-seconds", "300");
      nextArgv = ensureFlag(nextArgv, "--watch-timeout-seconds", "7200");
    }
  }

  if (kind === "image") {
    return [
      ...withoutFlags(nextArgv, ["--model", "--reasoning", "--thinking-effort", "--quality"]),
      "--job-kind",
      "api-image",
      "--output-kind",
      "image",
      "--kind",
      "image",
      "--quality",
      getFlag(argv, "--quality", "high"),
    ];
  }

  if (kind === "deep-research") {
    const hasModelHints = argv.includes("--model") || argv.includes("--reasoning") || argv.includes("--thinking-effort");
    const modeledArgv = hasModelHints ? applyModelPreset(nextArgv, { defaultModel: undefined, resolveBestModel }) : nextArgv;
    return [...modeledArgv, "--job-kind", "api-deep-research", "--kind", "deep-research"];
  }

  return applyModelPreset(nextArgv, { resolveBestModel });
}

export function firstPositionalIndex(argv, { valueFlags = VALUE_FLAGS } = {}) {
  for (let i = 0; i < argv.length; i += 1) {
    if (valueFlags.has(argv[i])) {
      i += 1;
      continue;
    }
    if (!String(argv[i]).startsWith("--")) return i;
  }
  return -1;
}

export function firstPositionalArg(argv, options = {}) {
  const index = firstPositionalIndex(argv, options);
  return index === -1 ? undefined : argv[index];
}

export function splitSelectorArg(argv, command) {
  const index = firstPositionalIndex(argv);
  if (index === -1) throw new Error(`${command} requires a chat number, ChatGPT conversation id, or Second Braincell job id.`);
  return {
    selector: argv[index],
    rest: [...argv.slice(0, index), ...argv.slice(index + 1)],
  };
}
