import { localSetupStatus } from "./local-config.js";

export const MODEL_PRESETS = {
  "gpt-5.3": {
    label: "GPT-5.3",
    model: "gpt-5-3",
    defaultReasoning: null,
    allowedReasoning: [],
    notes: "General text default; no thinking_effort override.",
  },
  "gpt-5.5-thinking": {
    label: "GPT-5.5 Thinking",
    model: "gpt-5-5-thinking",
    defaultReasoning: "standard",
    allowedReasoning: ["light", "standard", "heavy", "extended"],
    notes: "Default higher-reasoning model.",
  },
  "gpt-5.5-pro": {
    label: "GPT-5.5 Pro",
    model: "gpt-5-5-pro",
    defaultReasoning: "extended",
    allowedReasoning: ["standard", "extended"],
    notes: "Highest reasoning preset.",
  },
};

export const DEFAULT_TEXT_MODEL = "gpt-5.3";
export const DEFAULT_REASONING_MODEL = "gpt-5.5-thinking";

const MODEL_ALIASES = {
  "5.3": "gpt-5.3",
  "gpt 5.3": "gpt-5.3",
  "gpt-5-3": "gpt-5.3",
  "5.5 thinking": "gpt-5.5-thinking",
  "gpt 5.5 thinking": "gpt-5.5-thinking",
  "gpt-5-5-thinking": "gpt-5.5-thinking",
  "5.5 pro": "gpt-5.5-pro",
  "gpt 5.5 pro": "gpt-5.5-pro",
  "gpt-5-5-pro": "gpt-5.5-pro",
};

export function normalizeModelName(modelName) {
  const clean = String(modelName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return MODEL_ALIASES[clean] || clean;
}

export function resolveModelPreset({ modelName, reasoning, allowRawModel = true } = {}) {
  if (!modelName) return {};
  const normalized = normalizeModelName(modelName);
  const preset = MODEL_PRESETS[normalized];
  if (!preset) {
    if (!allowRawModel) {
      throw new Error(`Unknown model preset: ${modelName}. Use one of: ${Object.keys(MODEL_PRESETS).join(", ")}`);
    }
    return { model: modelName, thinkingEffort: reasoning || undefined, presetName: null };
  }

  if (reasoning && !preset.allowedReasoning.includes(reasoning)) {
    const supported = preset.allowedReasoning.length ? preset.allowedReasoning.join(", ") : "none";
    throw new Error(`${normalized} does not support reasoning '${reasoning}'. Supported reasoning: ${supported}.`);
  }

  return {
    model: preset.model,
    thinkingEffort: reasoning || preset.defaultReasoning || undefined,
    presetName: normalized,
  };
}

export function capabilities() {
  const setup = localSetupStatus();
  return {
    setup,
    commands: {
      setup: {
        description: "Create ignored .local/auth.json and .local/config.json from one project URL and one authenticated ChatGPT cURL.",
      },
      ask: {
        description: "Submit a ChatGPT web API job with agent-friendly defaults.",
        defaultAsync: true,
        asyncAgentBehavior:
          "For image and deep-research jobs, submit, create a thread heartbeat automation when available, then stop or continue with other work. Image jobs require a 30-second heartbeat; deep-research jobs require a 10-minute heartbeat. Do not poll or wait unless explicitly requested.",
        kinds: ["message", "image", "deep-research"],
        supportsAttachments: true,
      },
      converse: {
        description: "Start or continue a response-aware text conversation and write a combined transcript.",
        supportsContinuation: true,
        transcriptDefault: "output/conversations/",
      },
      chats: {
        description: "List recent ChatGPT conversations. Defaults to the configured Project; use --all only when explicitly requested.",
        defaultOutput: "human",
        detailedFlag: "--json",
      },
      "search-chats": {
        description: "Search ChatGPT conversations. Defaults to the configured Project; use --all or --project only when explicitly requested.",
        defaultOutput: "human",
        detailedFlag: "--json",
      },
      resume: {
        description: "Resume a previous ChatGPT conversation by recent-chat number, conversation id, job id, or --search.",
      },
      transcript: {
        description: "Export a ChatGPT conversation to Markdown by recent-chat number, conversation id, job id, or --search.",
      },
      status: {
        description: "Refresh and print a job record.",
      },
      jobs: {
        description: "List local Second Braincell jobs.",
        defaultOutput: "human",
        detailedFlag: "--json",
      },
      result: {
        description: "Print a saved job record.",
      },
    },
    models: MODEL_PRESETS,
    defaults: {
      messageModel: DEFAULT_TEXT_MODEL,
      reasoningModel: DEFAULT_REASONING_MODEL,
      imageQuality: "high",
      imageQualities: ["high", "instant"],
      deepResearch: {
        async: true,
        ready: setup.features.deepResearch,
      },
      attachments: {
        supported: true,
        flag: "--attach-file",
        ready: setup.features.attachments,
      },
    },
    readiness: {
      message: setup.features.message,
      imageHigh: setup.features.imageHigh,
      imageInstant: setup.features.imageInstant,
      deepResearch: setup.features.deepResearch,
      attachments: setup.features.attachments,
    },
  };
}
