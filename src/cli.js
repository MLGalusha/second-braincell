#!/usr/bin/env node
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asyncJobHeartbeatLabel, heartbeatAutomationForAsyncJob, updateApiJobStatus } from "./async-jobs.js";
import {
  applyModelPreset as applyModelPresetArgs,
  ensureFlag,
  firstPositionalArg,
  normalizeAskArgv,
  splitSelectorArg,
  withoutFlags,
} from "./cli-args.js";
import {
  formatChatList,
  formatConversationSummary,
  formatDate,
  formatHumanCapabilities,
  formatJobList,
  formatSearchResults,
  sanitizeChatSummary,
  sanitizeSearchResult,
} from "./cli-formatters.js";
import { createJob, listJobs, loadJob, saveJob, updateJob } from "./jobs.js";
import { JOBS_DIR, OUTPUT_DIR } from "./config.js";
import { displayPath, ensureDir, getFlag, getFlags, hasFlag, readJson, readTextArg, slugify, uniquePath, writeJson } from "./util.js";
import { BEST_MODEL_ORDER, capabilities, modelKey, normalizeModelName, resolveModelPreset } from "./model-presets.js";
import {
  authRefreshMessage,
  fetchConversation,
  fetchProjectResource,
  latestAssistantTextFromConversation,
  listAllConversations,
  listConversationsForProject,
  listProjectConversations,
  loadCurlTemplate,
  projectIdFromUrl,
  searchConversations,
  sendApiMessage,
  updateProjectInstructions,
  uploadFile,
} from "./chatgpt-api.js";
import { loadLocalHeaders, readCurlInputFile, writeLocalSetup } from "./local-config.js";

const __filename = fileURLToPath(import.meta.url);
const SETUP_FILTER = "conversation";

function color(code, value) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return value;
  return `\x1b[${code}m${value}\x1b[0m`;
}

function setupTitle(title) {
  console.log("");
  console.log(color("1;36", `== ${title} ==`));
}

function setupSteps(steps, start = 1) {
  for (const [index, step] of steps.entries()) {
    console.log(`  ${start + index}. ${step}`);
  }
}

async function waitForClipboard(label) {
  const prompt = color("1;33", `After copying the ${label}, press Enter. No need to paste. `);
  await promptSetupValue(prompt);
  return await readClipboard();
}

function usage() {
  return `
Usage:
  npm run chatgpt -- ask --prompt "..."
  npm run chatgpt -- connect
  npm run chatgpt -- ask --kind image --quality high --prompt "..."
  npm run chatgpt -- ask --kind deep-research --prompt "..."
  npm run chatgpt -- converse --prompt "Start a conversation..."
  npm run chatgpt -- chats
  npm run chatgpt -- search-chats "query"
  npm run chatgpt -- chat-summary --search "query"
  npm run chatgpt -- project-instructions
  npm run chatgpt -- resume <chat-number|conversation-id|job-id> --prompt "..."
  npm run chatgpt -- transcript <chat-number|conversation-id|job-id>
  npm run chatgpt -- status <job-id>
  npm run chatgpt -- capabilities
  npm run chatgpt -- model-check
  npm run chatgpt -- api-message --prompt "..."
  npm run chatgpt -- api-deep-research --prompt "..."
  npm run chatgpt -- api-image --async --watch --prompt "..."
  npm run chatgpt -- api-status <job-id>
  npm run chatgpt -- jobs
  npm run chatgpt -- result <job-id>

Options:
  --prompt TEXT
  --prompt-file PATH
  --async
  --curl PATH
  --curl-file PATH
  --project-url URL
  --model MODEL
  --reasoning standard|extended
  --thinking-effort VALUE
  --kind message|image|deep-research
  --quality high|instant
  --attach-file PATH (repeatable)
  --continue-job JOB_ID
  --conversation-id CONVERSATION_ID
  --parent-message-id MESSAGE_ID
  --transcript PATH
  --out PATH
  --limit N
  --all
  --project PROJECT_ID
  --search QUERY
  --set TEXT
  --set-file PATH
  --yes
  --max-turns N
  --sync
  --watch
  --notify
  --watch-interval-seconds N
  --watch-timeout-seconds N
`.trim();
}

async function promptSetupValue(question) {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const CONNECT_CURL_FALLBACK = "Use `--curl-file`, `--curl`, or pipe the cURL on stdin.";

function linuxClipboardInstallPlan() {
  if (process.platform !== "linux") return null;
  const wayland = Boolean(process.env.WAYLAND_DISPLAY);
  const helper = wayland ? "wl-clipboard" : "xclip";
  const candidates = [
    { manager: "apt-get", args: ["sudo", "apt-get", "install", "-y", helper] },
    { manager: "apt", args: ["sudo", "apt", "install", "-y", helper] },
    { manager: "dnf", args: ["sudo", "dnf", "install", "-y", helper] },
    { manager: "pacman", args: ["sudo", "pacman", "-S", "--needed", helper] },
    { manager: "zypper", args: ["sudo", "zypper", "install", "-y", helper] },
  ];
  for (const candidate of candidates) {
    try {
      execFileSync("which", [candidate.manager], { stdio: "ignore" });
      return { helper, installCommand: candidate.args };
    } catch {
      // Try the next package manager.
    }
  }
  return null;
}

async function maybeInstallLinuxClipboardHelper() {
  const plan = linuxClipboardInstallPlan();
  if (!plan || !process.stdin.isTTY) return false;
  const commandText = plan.installCommand.join(" ");
  const answer = (await promptSetupValue(`No Linux clipboard helper found. Install ${plan.helper} now with \`${commandText}\`? [y/N] `)).trim().toLowerCase();
  if (!["y", "yes"].includes(answer)) return false;
  const result = spawnSync(plan.installCommand[0], plan.installCommand.slice(1), { stdio: "inherit" });
  return result.status === 0;
}

function clipboardCommands() {
  return (
    process.platform === "darwin"
      ? [["pbpaste"]]
      : process.platform === "win32"
        ? [["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"]]
        : [
            ["wl-paste", "--no-newline"],
            ["xclip", "-selection", "clipboard", "-out"],
            ["xsel", "--clipboard", "--output"],
          ]
  );
}

function readClipboardOnce() {
  const commands = clipboardCommands();
  for (const [command, ...args] of commands) {
    try {
      const value = execFileSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 }).trim();
      if (value) return value;
    } catch {
      // Try the next platform clipboard command.
    }
  }
  return null;
}

async function readClipboard() {
  const first = readClipboardOnce();
  if (first) return first;
  if (process.platform === "linux" && (await maybeInstallLinuxClipboardHelper())) {
    const afterInstall = readClipboardOnce();
    if (afterInstall) return afterInstall;
  }
  throw new Error(
    process.platform === "linux"
      ? `Could not read the clipboard. Install one clipboard helper such as \`wl-clipboard\`, \`xclip\`, or \`xsel\`, or ${CONNECT_CURL_FALLBACK}`
      : `Could not read the clipboard. ${CONNECT_CURL_FALLBACK}`,
  );
}

async function runSetup(argv) {
  let projectUrl = getFlag(argv, "--project-url", undefined);
  let curlText = getFlag(argv, "--curl", undefined);
  const curlFile = getFlag(argv, "--curl-file", undefined);
  if (curlFile) curlText = readCurlInputFile(curlFile);
  const interactive = process.stdin.isTTY && !curlText && !curlFile;
  if (interactive) {
    console.log(color("1", "\nSecond Braincell connect"));
    console.log("This connection step reads from your clipboard after you press Enter. Anything typed or pasted at these prompts is ignored.");
  }
  if (!curlText && process.stdin.isTTY) {
    setupTitle("Copy one authenticated Project cURL");
    setupSteps([
      "Open ChatGPT and create a Project named `Codex` if you do not already have one.",
      "Before creating a new Project, click the settings button and set Project memory to project-only.",
      "Open the ChatGPT Project in the browser.",
      "Right-click the ChatGPT page and click Inspect.",
      "In DevTools, click the Network tab.",
      "Click the clear network log button in the top-left of Network: ⊘",
      "Click the Network filter box directly below that clear button.",
      `Type this filter into that box: ${SETUP_FILTER}`,
      "While the Network tab is open, go back to your ChatGPT Project and send a message.",
      "A request named `conversation` should appear in the Network table. Its icon is an orange square with <> inside it.",
      "Right-click the `conversation` request and choose Copy > Copy as cURL.",
    ]);
    curlText = await waitForClipboard("cURL");
  }
  if (!curlText && !process.stdin.isTTY) curlText = readFileSync(0, "utf8");
  const status = writeLocalSetup({ projectUrl, curlText });
  const summary = {
    ready: status.ready,
    authPath: status.auth.path,
    configPath: status.config.path,
    projectId: status.config.projectId,
    next: "npm run capabilities",
  };
  if (!process.stdout.isTTY) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  setupTitle("Connection complete");
  console.log(`  Ready: ${color("32", String(summary.ready))}`);
  console.log(`  Project ID: ${summary.projectId}`);
  console.log(`  Config: ${summary.configPath}`);
  console.log(`  Auth: ${summary.authPath}`);
  console.log("");
  console.log(color("1", "Next:"));
  console.log("  1. Go to your Codex agent.");
  console.log("  2. Tell it: Read and follow `skills/chatgpt-direct-api/SKILL.md`.");
  console.log('  3. Test it: Use the ChatGPT direct API runner to ask "Reply with exactly: agent works".');
  console.log("");
  console.log(color("1", "Manual smoke test:"));
  console.log('  npm run ask -- --sync --prompt "Reply with exactly: clone works"');
}

async function runDirectApiMessage(argv, { silent = false } = {}) {
  const prompt = readTextArg(argv);
  const curlPath = getFlag(argv, "--curl", undefined);
  let model = getFlag(argv, "--model", undefined);
  let thinkingEffort = getFlag(argv, "--thinking-effort", undefined);
  const continueJobId = getFlag(argv, "--continue-job", undefined);
  let conversationId = getFlag(argv, "--conversation-id", undefined);
  const parentMessageId = getFlag(argv, "--parent-message-id", undefined);
  let modelPreset = getFlag(argv, "--model-preset", undefined);
  const modelSelection = getFlag(argv, "--model-selection", undefined);
  const outputKind = getFlag(argv, "--output-kind", "text");
  const jobKind = getFlag(argv, "--job-kind", outputKind === "image" ? "api-image" : "api-message");
  const kind = getFlag(argv, "--kind", jobKind === "api-deep-research" ? "deep-research" : outputKind === "image" ? "image" : "message");
  const quality = getFlag(argv, "--quality", "high");
  const isAsync = hasFlag(argv, "--async");
  const suppressInitialResponse = isAsync && kind === "deep-research";
  const watchIntervalSeconds = getFlag(argv, "--watch-interval-seconds", undefined);
  const watchTimeoutSeconds = getFlag(argv, "--watch-timeout-seconds", undefined);
  const attachFiles = getFlags(argv, "--attach-file");
  const { job } = createJob({
    kind: jobKind,
    prompt,
    options: {
      curlPath,
      model,
      thinkingEffort,
      continueJobId,
      conversationId: conversationId ? ":conversation_id" : undefined,
      parentMessageId: parentMessageId ? ":parent_message_id" : undefined,
      modelPreset,
      modelSelection,
      outputKind,
      jobKind,
      kind,
      quality,
      attachFiles,
      watchIntervalSeconds,
      watchTimeoutSeconds,
    },
  });

  try {
    if (continueJobId) {
      const previousJob = loadJob(continueJobId);
      if (!previousJob.conversationId) throw new Error(`Job ${continueJobId} has no conversation id to continue.`);
      conversationId = previousJob.conversationId;
    }
    const headers = curlPath ? loadCurlTemplate(curlPath).headers : loadLocalHeaders();
    const attachments = [];
    for (const file of attachFiles) {
      attachments.push(await uploadFile({ headers, filePath: file }));
    }
    if (attachments.length) {
      job.artifacts.attachments = attachments.map((attachment) => ({
        id: ":file_id",
        name: attachment.name,
        size: attachment.size,
        mimeType: attachment.mimeType,
        processEvents: attachment.processEvents,
      }));
      saveJob(job);
    }
    let result = null;
    const attempts = modelSelection === "best" ? modelAttemptsForBest({ model, thinkingEffort, modelPreset }) : [{ model, thinkingEffort, modelPreset }];
    const fallbackLog = [];
    for (const attempt of attempts) {
      model = attempt.model;
      thinkingEffort = attempt.thinkingEffort;
      modelPreset = attempt.modelPreset;
      result = await sendApiMessage({
        prompt,
        curlPath,
        model,
        thinkingEffort,
        attachments,
        conversationId,
        parentMessageId,
        fetchFinalText: outputKind !== "image" && kind !== "deep-research",
        forceFetchFinalText: outputKind !== "image" && kind !== "deep-research" && !isAsync,
        submitOnly: isAsync,
        kind,
        quality,
      });
      if (isAuthExpiredResult(result)) break;
      if (result.ok && !result.errorSeen) {
        markModelCapability({ modelPreset, thinkingEffort, model, available: true, status: result.status });
        break;
      }
      if (isModelUnavailableResult(result)) {
        markModelCapability({ modelPreset, thinkingEffort, model, available: false, status: result.status });
        fallbackLog.push({ modelPreset, thinkingEffort, status: result.status });
        if (modelSelection === "best") continue;
      }
      break;
    }
    if (!result) throw new Error("No model attempt was made.");
    if (fallbackLog.length) job.modelFallbacks = fallbackLog;
    job.options.model = model;
    job.options.thinkingEffort = thinkingEffort;
    job.options.modelPreset = modelPreset;
    job.status = isAuthExpiredResult(result) ? "needs_connect" : result.ok && !result.errorSeen ? (isAsync ? "submitted" : "completed") : "failed";
    job.statusCode = result.status;
    job.contentType = result.contentType;
    job.conversationId = result.conversationId;
    job.finishSeen = result.finishSeen;
    job.errorSeen = result.errorSeen;
    job.eventTypes = result.eventTypes;
    job.responseLength = result.responseText?.length || 0;
    const modelUnavailableMessage =
      modelSelection === "best" && fallbackLog.some((entry) => entry.modelPreset === "pro")
        ? modelUnavailableMessageForResult({ ok: false, status: fallbackLog.find((entry) => entry.modelPreset === "pro")?.status }, { modelPreset: "pro", modelSelection })
        : modelUnavailableMessageForResult(result, { modelPreset, modelSelection });
    if (modelUnavailableMessage) job.message = modelUnavailableMessage;
    if (isAuthExpiredResult(result)) job.message = result.message || authRefreshMessage();
    if (curlPath) job.options.curlPath = curlPath;
    saveJob(job);
    const responsePath = resolve(JOBS_DIR, job.id, "response.md");
    if (result.responseText && outputKind !== "image" && !suppressInitialResponse) writeFileSync(responsePath, `${result.responseText}\n`);
    if (!isAsync && outputKind === "image") await updateApiJobStatus(job);
    if (isAsync && hasFlag(argv, "--watch")) {
      startApiWatcher(job.id, {
        notify: hasFlag(argv, "--notify"),
        intervalSeconds: watchIntervalSeconds,
        timeoutSeconds: watchTimeoutSeconds,
      });
    }

    const heartbeatAutomation = isAsync ? heartbeatAutomationForAsyncJob(job.id, kind) : undefined;
    const payload = {
      id: job.id,
      jobStatus: loadJob(job.id).status,
      status: result.status,
      ok: result.ok,
      conversationId: result.conversationId ? ":conversation_id" : null,
      responsePath: existsSync(responsePath) && outputKind !== "image" && !suppressInitialResponse ? responsePath : undefined,
      response: outputKind === "image" || suppressInitialResponse ? undefined : result.responseText,
      message: loadJob(job.id).message,
      modelFallbacks: loadJob(job.id).modelFallbacks,
      artifacts: loadJob(job.id).artifacts,
      statusCommand: `npm run chatgpt -- status ${job.id}`,
      watchStatusPath: resolve(JOBS_DIR, job.id, "watch-status.json"),
      agentInstruction: isAsync
        ? `Async ${kind} job submitted and background watcher started. Create a thread heartbeat automation with a ${asyncJobHeartbeatLabel(kind)} interval to report completion when available, then do not poll or wait unless explicitly asked.`
        : undefined,
      heartbeatAutomation,
    };
    if (!silent) console.log(JSON.stringify(payload, null, 2));
    return payload;
  } catch (error) {
    if (error?.code === "CHATGPT_AUTH_EXPIRED") {
      job.status = "needs_connect";
      job.message = authRefreshMessage();
    } else {
      job.status = "failed";
    }
    job.error = String(error.stack || error.message || error);
    saveJob(job);
    throw error;
  }
}

const MODEL_CAPABILITIES_PATH = resolve(ROOT_DIR, ".local", "model-capabilities.json");

function nowIsoForCli() {
  return new Date().toISOString();
}

function loadModelCapabilities() {
  if (!existsSync(MODEL_CAPABILITIES_PATH)) return null;
  try {
    return readJson(MODEL_CAPABILITIES_PATH);
  } catch {
    return null;
  }
}

function saveModelCapabilities(data) {
  ensureDir(dirname(MODEL_CAPABILITIES_PATH));
  writeJson(MODEL_CAPABILITIES_PATH, data);
}

function modelCheckCases({ modelName, reasoning } = {}) {
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

function formatModelCheckName(result) {
  return result.reasoning ? `${result.modelName} ${result.reasoning}` : result.modelName;
}

function resolveBestModelFromResults(results) {
  const byKey = new Map(results.map((result) => [result.key, result]));
  for (const candidate of BEST_MODEL_ORDER) {
    const found = byKey.get(modelKey(candidate));
    if (found?.available) return found;
  }
  return null;
}

function resolveBestModelFromCache() {
  const cache = loadModelCapabilities();
  const best = cache?.best;
  if (best?.modelName) return { modelName: best.modelName, reasoning: best.reasoning };
  return BEST_MODEL_ORDER[0];
}

function isModelUnavailableResult(result) {
  return Boolean(result && !result.authExpired && !result.ok && result.status === 422);
}

function isAuthExpiredResult(result) {
  return Boolean(result?.authExpired || [401, 403].includes(result?.status));
}

function keyForResolvedModel({ modelPreset, thinkingEffort } = {}) {
  return modelKey({ modelName: modelPreset, reasoning: thinkingEffort });
}

function markModelCapability({ modelPreset, thinkingEffort, model, available, status }) {
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

function modelUnavailableMessageForResult(result, { modelPreset, modelSelection } = {}) {
  if (!isModelUnavailableResult(result) || modelPreset !== "pro") return undefined;
  if (modelSelection === "best") {
    return "GPT-5.5 Pro was unavailable for this signed-in ChatGPT account, so best-mode tried the next available checked model.";
  }
  return "GPT-5.5 Pro is not available for this signed-in ChatGPT account. Run `npm run model-check -- --model pro`, change or upgrade the ChatGPT account, or use `--model thinking --reasoning extended`.";
}

function modelAttemptsForBest(current = {}) {
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

function applyModelPreset(argv, options = {}) {
  return applyModelPresetArgs(argv, { resolveBestModel: resolveBestModelFromCache, ...options });
}

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

async function runModelCheck(argv) {
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

async function runAsk(argv) {
  await runDirectApiMessage(normalizeAskArgv(argv, { resolveBestModel: resolveBestModelFromCache }));
}

function transcriptDefaultPath() {
  return resolve(OUTPUT_DIR, "conversations", `conversation_${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
}

function appendTranscriptTurn(path, { turn, prompt, response, jobId, responsePath }) {
  appendFileSync(
    path,
    [
      `## Turn ${turn}`,
      "",
      "**User**",
      "",
      prompt.trim(),
      "",
      "**ChatGPT**",
      "",
      String(response || "").trim() || "(no response text)",
      "",
      `Job: \`${jobId}\``,
      responsePath ? `Response file: \`${responsePath}\`` : null,
      "",
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );
}

function conversationMessages(history) {
  return Object.values(history.mapping || {})
    .map((node) => node?.message)
    .filter((message) => {
      if (!message?.author?.role) return false;
      if (!["user", "assistant"].includes(message.author.role)) return false;
      if (message.metadata?.is_visually_hidden_from_conversation) return false;
      if (message.metadata?.chatgpt_sdk_suppressed_response) return false;
      if (message.metadata?.tool_invoked_message || message.metadata?.tool_invoking_message) return false;
      return Boolean((message.content?.parts || []).some((part) => typeof part === "string" && part.trim()));
    })
    .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
}

function transcriptFromConversation(history, conversationId) {
  const title = history.title || "ChatGPT Conversation";
  const lines = [`# ${title}`, "", `Conversation ID: \`${conversationId}\``, ""];
  for (const message of conversationMessages(history)) {
    const role = message.author.role === "assistant" ? "ChatGPT" : "User";
    const text = (message.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
    if (!text) continue;
    lines.push(`## ${role}`);
    lines.push("");
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function transcriptPathFor(history, conversationId, explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  const title = slugify(history.title || conversationId, "conversation").replace(/\s+/g, "-").toLowerCase();
  return uniquePath(resolve(OUTPUT_DIR, "conversations"), title, ".md");
}

function messageText(message) {
  return (message.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
}

function truncateMiddle(value, length = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= length) return text;
  const head = Math.floor((length - 20) * 0.6);
  const tail = length - 20 - head;
  return `${text.slice(0, head).trimEnd()} ... ${text.slice(-tail).trimStart()}`;
}

function conversationSummary(history, conversationId, { maxMessages = 8, maxChars = 900 } = {}) {
  const messages = conversationMessages(history);
  const firstUser = messages.find((message) => message.author.role === "user");
  const assistantMessages = messages.filter((message) => message.author.role === "assistant");
  const latestAssistant = assistantMessages.at(-1);
  const included = messages.slice(-maxMessages);
  return {
    conversationId,
    title: history.title || null,
    createTime: history.create_time || null,
    updateTime: history.update_time || null,
    messageCount: messages.length,
    firstUserMessage: firstUser ? truncateMiddle(messageText(firstUser), maxChars) : null,
    latestAssistantMessage: latestAssistant ? truncateMiddle(messageText(latestAssistant), maxChars) : null,
    recentMessages: included.map((message) => ({
      role: message.author.role === "assistant" ? "ChatGPT" : "User",
      text: truncateMiddle(messageText(message), maxChars),
    })),
  };
}

function projectInstructionsBackupPath(projectId) {
  return uniquePath(resolve(OUTPUT_DIR, "project-instructions"), `${projectId}_${new Date().toISOString().replace(/[:.]/g, "-")}`, ".md");
}

function projectSummary(resource) {
  const gizmo = resource.gizmo || {};
  return {
    projectId: gizmo.id,
    name: gizmo.display?.name || null,
    instructions: gizmo.instructions || "",
    instructionsLength: (gizmo.instructions || "").length,
    memoryScope: gizmo.memory_scope || null,
    updatedAt: gizmo.updated_at || null,
  };
}

async function recentChats(limit) {
  return listProjectConversations(loadLocalHeaders(), { limit });
}

function scopeProjectId(argv) {
  const project = getFlag(argv, "--project", undefined);
  if (project) return project;
  return undefined;
}

async function scopedChats(argv, { limit = 20 } = {}) {
  const headers = loadLocalHeaders();
  const project = scopeProjectId(argv);
  if (hasFlag(argv, "--all")) return listAllConversations(headers, { limit });
  if (project) return listConversationsForProject(headers, project, { limit });
  return listProjectConversations(headers, { limit });
}

function searchQueryArg(argv) {
  const flagged = getFlag(argv, "--search", getFlag(argv, "--query", undefined));
  if (flagged) return flagged;
  const positional = firstPositionalArg(argv);
  if (positional) return positional;
  throw new Error("Search query is required.");
}

async function scopedSearch(argv, { limit = 10 } = {}) {
  const headers = loadLocalHeaders();
  const project = scopeProjectId(argv);
  const useDefaultProject = !hasFlag(argv, "--all") && !project;
  const projectId = project || (useDefaultProject ? projectIdFromUrl() : undefined);
  const query = searchQueryArg(argv);
  const results = await searchConversations(headers, { query, limit, projectId });
  return { query, results };
}

async function resolveConversationFromSearch(argv, { limit = 10 } = {}) {
  const { query, results } = await scopedSearch(argv, { limit });
  const result = results[0];
  if (!result?.conversation_id) throw new Error(`No matching ChatGPT chats found for: ${query}`);
  return { conversationId: result.conversation_id, source: "search", result };
}

async function resolveConversationSelector(selector, { limit = 30, argv = [] } = {}) {
  if (!selector) throw new Error("Expected a chat number, ChatGPT conversation id, or Second Braincell job id.");

  if (/^\d+$/.test(selector)) {
    const chats = await scopedChats(argv, { limit });
    const chat = chats[Number(selector) - 1];
    if (!chat) throw new Error(`No recent chat at position ${selector}. Run \`npm run chats\` to see available chats.`);
    return { conversationId: chat.id, source: "recent-chat", chat };
  }

  if (existsSync(jobPathForSelector(selector))) {
    const job = loadJob(selector);
    if (!job.conversationId) throw new Error(`Job ${selector} has no ChatGPT conversation id.`);
    return { conversationId: job.conversationId, source: "job", job };
  }

  return { conversationId: selector, source: "conversation-id" };
}

function jobPathForSelector(selector) {
  return resolve(JOBS_DIR, selector, "job.json");
}

async function runConverse(argv) {
  const kind = getFlag(argv, "--kind", "message");
  if (kind !== "message") throw new Error("converse currently supports text message conversations only.");

  const transcriptPath = resolve(getFlag(argv, "--transcript", transcriptDefaultPath()));
  ensureDir(dirname(transcriptPath));
  writeFileSync(transcriptPath, "# ChatGPT Conversation\n\n");

  const firstPrompt = getFlag(argv, "--prompt", undefined) || (hasFlag(argv, "--prompt-file") || hasFlag(argv, "--file") ? readTextArg(argv) : undefined);
  if (!firstPrompt && !process.stdin.isTTY) throw new Error("Provide --prompt or --prompt-file when stdin is not interactive.");
  const maxTurnsRaw = getFlag(argv, "--max-turns", undefined);
  const defaultMaxTurns = firstPrompt && !process.stdin.isTTY ? 1 : Infinity;
  const maxTurns = maxTurnsRaw === undefined ? defaultMaxTurns : Number(maxTurnsRaw);
  if (!Number.isFinite(maxTurns) && maxTurnsRaw !== undefined) throw new Error("--max-turns must be a number");
  if (maxTurns < 1) throw new Error("--max-turns must be at least 1");

  const baseArgv = withoutFlags(argv, ["--prompt", "--prompt-file", "--file", "--transcript", "--max-turns", "--continue-job", "--kind"]);
  const followupBaseArgv = withoutFlags(baseArgv, ["--attach-file"]);
  const rl = createInterface({ input, output });
  let prompt = firstPrompt || (await rl.question("First prompt: "));
  let continueJobId = getFlag(argv, "--continue-job", undefined);
  let turn = 1;

  try {
    while (prompt.trim() && !["/end", "end", "/done", "done"].includes(prompt.trim().toLowerCase()) && turn <= maxTurns) {
      const turnArgv = [...(turn === 1 ? baseArgv : followupBaseArgv), "--prompt", prompt];
      if (continueJobId) turnArgv.push("--continue-job", continueJobId);
      const result = await runDirectApiMessage(applyModelPreset(turnArgv), { silent: true });
      appendTranscriptTurn(transcriptPath, {
        turn,
        prompt,
        response: result.response,
        jobId: result.id,
        responsePath: result.responsePath,
      });

      console.log("");
      console.log(color("1;36", `Turn ${turn} complete`));
      console.log(`Job: ${result.id}`);
      console.log(`Transcript: ${transcriptPath}`);
      console.log("");
      console.log(result.response || "(no response text)");
      console.log("");

      if (isAuthExpiredResult(result)) throw new Error(result.message || authRefreshMessage());
      if (!result.ok) throw new Error(`Turn ${turn} failed with status ${result.status}`);
      continueJobId = result.id;
      turn += 1;
      if (turn > maxTurns) break;
      prompt = await rl.question("Next prompt (blank or /end to end): ");
    }
  } finally {
    rl.close();
  }

  console.log(
    JSON.stringify(
      {
        completedTurns: turn - 1,
        latestJobId: continueJobId,
        transcriptPath,
      },
      null,
      2,
    ),
  );
}

async function runChats(argv) {
  const limit = Number(getFlag(argv, "--limit", 20));
  if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit must be a positive number");
  const chats = await scopedChats(argv, { limit });
  if (hasFlag(argv, "--json") || hasFlag(argv, "--detailed")) {
    console.log(JSON.stringify(chats.map(sanitizeChatSummary), null, 2));
  } else {
    console.log(formatChatList(chats, argv));
  }
}

async function runSearchChats(argv) {
  const limit = Number(getFlag(argv, "--limit", 10));
  if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit must be a positive number");
  const { query, results } = await scopedSearch(argv, { limit });
  if (hasFlag(argv, "--json") || hasFlag(argv, "--detailed")) {
    console.log(JSON.stringify(results.map(sanitizeSearchResult), null, 2));
  } else {
    console.log(formatSearchResults(results, query, argv));
  }
}

async function runResume(argv) {
  let rest = argv;
  let resolved;
  if (hasFlag(argv, "--search") || hasFlag(argv, "--query")) {
    resolved = await resolveConversationFromSearch(argv, { limit: Number(getFlag(argv, "--limit", 10)) || 10 });
  } else {
    const split = splitSelectorArg(argv, "resume");
    rest = split.rest;
    resolved = await resolveConversationSelector(split.selector, { limit: Number(getFlag(rest, "--limit", 30)) || 30, argv: rest });
  }
  await runConverse([...rest, "--conversation-id", resolved.conversationId]);
}

async function runTranscript(argv) {
  let rest = argv;
  let resolved;
  if (hasFlag(argv, "--search") || hasFlag(argv, "--query")) {
    resolved = await resolveConversationFromSearch(argv, { limit: Number(getFlag(argv, "--limit", 10)) || 10 });
  } else {
    const split = splitSelectorArg(argv, "transcript");
    rest = split.rest;
    resolved = await resolveConversationSelector(split.selector, { limit: Number(getFlag(rest, "--limit", 30)) || 30, argv: rest });
  }
  const history = await fetchConversation(loadLocalHeaders(), resolved.conversationId);
  const markdown = transcriptFromConversation(history, resolved.conversationId);

  if (hasFlag(rest, "--print")) {
    console.log(markdown.trimEnd());
    return;
  }

  const outPath = transcriptPathFor(history, resolved.conversationId, getFlag(rest, "--out", undefined));
  ensureDir(dirname(outPath));
  writeFileSync(outPath, markdown);
  const payload = {
    conversationId: resolved.conversationId,
    title: history.title || null,
    messages: conversationMessages(history).length,
    transcriptPath: outPath,
    displayPath: displayPath(outPath),
  };
  if (hasFlag(rest, "--json") || hasFlag(rest, "--detailed")) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(color("1;36", "Transcript exported"));
    console.log("");
    console.log(`Title: ${payload.title || "Untitled chat"}`);
    console.log(`Messages: ${payload.messages}`);
    console.log(`Path: ${payload.displayPath}`);
  }
}

async function runChatSummary(argv) {
  let rest = argv;
  let resolved;
  if (hasFlag(argv, "--search") || hasFlag(argv, "--query")) {
    resolved = await resolveConversationFromSearch(argv, { limit: Number(getFlag(argv, "--limit", 10)) || 10 });
  } else {
    const split = splitSelectorArg(argv, "chat-summary");
    rest = split.rest;
    resolved = await resolveConversationSelector(split.selector, { limit: Number(getFlag(rest, "--limit", 30)) || 30, argv: rest });
  }
  const history = await fetchConversation(loadLocalHeaders(), resolved.conversationId);
  const summary = conversationSummary(history, resolved.conversationId, {
    maxMessages: Number(getFlag(rest, "--max-messages", 8)) || 8,
    maxChars: Number(getFlag(rest, "--max-chars", 900)) || 900,
  });
  if (hasFlag(rest, "--json") || hasFlag(rest, "--detailed")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatConversationSummary(summary));
  }
}

async function runProjectInstructions(argv) {
  const projectId = scopeProjectId(argv) || projectIdFromUrl();
  if (!projectId) throw new Error("No ChatGPT Project ID configured. Run `npm run connect` first.");
  const headers = loadLocalHeaders();

  const setText = getFlag(argv, "--set", undefined);
  const setFile = getFlag(argv, "--set-file", undefined);
  const outPath = getFlag(argv, "--out", undefined);

  if (setText !== undefined || setFile !== undefined) {
    if (setText !== undefined && setFile !== undefined) throw new Error("Use either --set or --set-file, not both.");
    const nextInstructions = setFile !== undefined ? readFileSync(resolve(setFile), "utf8").trimEnd() : setText;
    const current = await fetchProjectResource(headers, projectId);
    const before = projectSummary(current);
    if (!hasFlag(argv, "--yes")) {
      console.log(color("1;36", "Project instructions update preview"));
      console.log("");
      console.log(`Project: ${before.name || projectId}`);
      console.log(`Project ID: ${projectId}`);
      console.log(`Current length: ${before.instructionsLength}`);
      console.log(`New length: ${nextInstructions.length}`);
      console.log("");
      console.log("No changes were made. Re-run with --yes to update.");
      return;
    }

    const backupPath = projectInstructionsBackupPath(projectId);
    ensureDir(dirname(backupPath));
    writeFileSync(backupPath, before.instructions ? `${before.instructions}\n` : "");
    const updated = await updateProjectInstructions(headers, { projectId, instructions: nextInstructions });
    const after = projectSummary(updated.result.resource || (await fetchProjectResource(headers, projectId)));
    console.log(
      JSON.stringify(
        {
          projectId,
          name: after.name,
          previousLength: before.instructionsLength,
          newLength: after.instructionsLength,
          backupPath,
          displayPath: displayPath(backupPath),
        },
        null,
        2,
      ),
    );
    return;
  }

  const resource = await fetchProjectResource(headers, projectId);
  const summary = projectSummary(resource);
  if (outPath) {
    const absolute = resolve(outPath);
    ensureDir(dirname(absolute));
    writeFileSync(absolute, summary.instructions ? `${summary.instructions}\n` : "");
    console.log(
      JSON.stringify(
        {
          projectId,
          name: summary.name,
          instructionsLength: summary.instructionsLength,
          path: absolute,
          displayPath: displayPath(absolute),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (hasFlag(argv, "--json") || hasFlag(argv, "--detailed")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(color("1;36", "ChatGPT Project Instructions"));
  console.log("");
  console.log(`Project: ${summary.name || projectId}`);
  console.log(`Project ID: ${projectId}`);
  console.log(`Length: ${summary.instructionsLength}`);
  console.log("");
  console.log(summary.instructions || "(no Project instructions set)");
}

function startApiWatcher(jobId, { notify = false, intervalSeconds, timeoutSeconds } = {}) {
  const args = [resolve("scripts/watch-api-job.js"), jobId];
  if (intervalSeconds) args.push("--interval-seconds", String(intervalSeconds));
  if (timeoutSeconds) args.push("--timeout-seconds", String(timeoutSeconds));
  if (notify) args.push("--notify");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  try {
    if (!command || command === "help" || command === "--help") {
      console.log(usage());
      return;
    }

    if (command === "connect" || command === "setup") {
      await runSetup(argv);
      return;
    }

    if (command === "capabilities") {
      const data = capabilities();
      if (hasFlag(argv, "--detailed") || hasFlag(argv, "--json")) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatHumanCapabilities(data));
      }
      return;
    }

    if (command === "model-check") {
      await runModelCheck(argv);
      return;
    }

    if (command === "ask") {
      await runAsk(argv);
      return;
    }

    if (command === "converse") {
      await runConverse(argv);
      return;
    }

    if (command === "chats") {
      await runChats(argv);
      return;
    }

    if (command === "search-chats") {
      await runSearchChats(argv);
      return;
    }

    if (command === "project-instructions") {
      await runProjectInstructions(argv);
      return;
    }

    if (command === "resume") {
      await runResume(argv);
      return;
    }

    if (command === "transcript") {
      await runTranscript(argv);
      return;
    }

    if (command === "chat-summary") {
      await runChatSummary(argv);
      return;
    }

    if (command === "api-message") {
      await runDirectApiMessage(argv);
      return;
    }

    if (command === "api-deep-research") {
      const nextArgv = [...argv, "--job-kind", "api-deep-research", "--kind", "deep-research"];
      await runDirectApiMessage(nextArgv);
      return;
    }

    if (command === "api-image") {
      const nextArgv = [...argv, "--output-kind", "image", "--kind", "image"];
      await runDirectApiMessage(nextArgv);
      return;
    }

    if (command === "api-status" || command === "status") {
      const id = argv[0];
      if (!id) throw new Error(`${command} requires a job id`);
      const existingJob = loadJob(id);
      let job;
      try {
        job = await updateApiJobStatus(existingJob);
      } catch (error) {
        if (error?.code !== "CHATGPT_AUTH_EXPIRED") throw error;
        job = updateJob(existingJob, {
          status: "needs_connect",
          message: authRefreshMessage(),
          error: String(error.stack || error.message || error),
        });
      }
      console.log(JSON.stringify(job, null, 2));
      return;
    }

    if (command === "jobs") {
      const jobs = listJobs(Number(getFlag(argv, "--limit", 30)));
      if (hasFlag(argv, "--json") || hasFlag(argv, "--detailed")) {
        console.log(JSON.stringify(jobs, null, 2));
      } else {
        console.log(formatJobList(jobs));
      }
      return;
    }

    if (command === "result") {
      const id = argv[0];
      if (!id) throw new Error("result requires a job id");
      console.log(JSON.stringify(loadJob(id), null, 2));
      return;
    }

    if (existsSync(resolve(JOBS_DIR, command, "job.json"))) {
      console.log(JSON.stringify(loadJob(command), null, 2));
      return;
    }

    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  } catch (error) {
    console.error(error?.code === "CHATGPT_AUTH_EXPIRED" ? error.message : String(error.stack || error.message || error));
    process.exit(1);
  }
}

if (process.argv[1] === __filename) main();
