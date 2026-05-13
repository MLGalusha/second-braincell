#!/usr/bin/env node
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, listJobs, loadJob, saveJob, updateJob } from "./jobs.js";
import { IMAGES_DIR, JOBS_DIR, OUTPUT_DIR, ROOT_DIR } from "./config.js";
import { displayPath, ensureDir, getFlag, getFlags, hasFlag, readJson, readTextArg, slugify, uniquePath, writeJson } from "./util.js";
import { BEST_MODEL_ORDER, DEFAULT_TEXT_MODEL, capabilities, modelKey, normalizeModelName, resolveModelPreset } from "./model-presets.js";
import {
  authRefreshMessage,
  downloadGeneratedImage,
  deepResearchReportFromConversation,
  fetchConversation,
  fetchProjectResource,
  findImageAssetPointers,
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

function checkmark(value) {
  return value ? color("32", "✓") : color("31", "✗");
}

function featureLine(label, ready) {
  return `  ${checkmark(ready)} ${label}`;
}

function formatHumanCapabilities(data) {
  const lines = [];
  const setup = data.setup;
  const projectName = setup.config.projectUrl ? setup.config.projectUrl.split("/").filter(Boolean).at(-2) || "configured project" : null;

  lines.push(color("1;36", "Second Braincell"));
  lines.push("");
  lines.push(`Status: ${setup.ready ? color("32", "ready") : color("31", "connection incomplete")}`);
  if (setup.config.ready) {
    lines.push(`Project: ${projectName || "configured"}`);
    lines.push(`Project ID: ${setup.config.projectId}`);
  }
  lines.push("");

  if (!setup.ready) {
    lines.push("Missing:");
    if (!setup.auth.ready) lines.push(featureLine(".local/auth.json", false));
    if (!setup.config.ready) lines.push(featureLine(".local/config.json", false));
    for (const hint of setup.hints || []) lines.push(`  - ${hint}`);
    lines.push("");
    lines.push("Next step:");
    lines.push("  npm run connect");
    lines.push("");
  }

  lines.push("Capabilities:");
  lines.push(featureLine("Text conversations", data.readiness.message));
  lines.push(featureLine("File and PDF questions", data.readiness.attachments));
  lines.push(featureLine("Image generation: high", data.readiness.imageHigh));
  lines.push(featureLine("Image generation: instant", data.readiness.imageInstant));
  lines.push(featureLine("Deep Research", data.readiness.deepResearch));
  lines.push("");

  lines.push("Default commands:");
  lines.push('  npm run converse -- --prompt "Have a conversation with ChatGPT about this decision."');
  lines.push("  npm run chats");
  lines.push('  npm run search-chats -- "observability roadmap"');
  lines.push("  npm run chatgpt -- project-instructions");
  lines.push("  npm run resume -- 1");
  lines.push("  npm run transcript -- 1");
  lines.push('  npm run ask -- --attach-file ./document.pdf --prompt "Answer questions about this file."');
  lines.push('  npm run ask -- --kind image --prompt "A red cube on a white table."');
  lines.push('  npm run ask -- --kind deep-research --prompt "Research this topic."');
  lines.push("");
  lines.push("Detailed JSON:");
  lines.push("  npm run capabilities -- --detailed");

  return lines.join("\n");
}

function formatDate(value) {
  if (!value) return "unknown";
  const normalized = typeof value === "number" && value > 0 && value < 1000000000000 ? value * 1000 : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function truncate(value, length = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function conversationTitle(chat) {
  return chat?.title || chat?.snippet || "Untitled chat";
}

function sanitizeChatSummary(chat) {
  return {
    id: chat.id,
    title: chat.title || null,
    create_time: chat.create_time || null,
    update_time: chat.update_time || null,
    is_archived: Boolean(chat.is_archived),
    is_temporary_chat: Boolean(chat.is_temporary_chat),
    memory_scope: chat.memory_scope || null,
    async_status: chat.async_status || null,
    snippet: chat.snippet || null,
  };
}

function sanitizeSearchResult(result) {
  return {
    conversation_id: result.conversation_id,
    title: result.title || null,
    update_time: result.update_time || null,
    is_archived: Boolean(result.is_archived),
    snippet: result.payload?.snippet || null,
    message_id: result.payload?.message_id || null,
  };
}

function scopeLabel(argv) {
  if (hasFlag(argv, "--all")) return "All ChatGPT Chats";
  const project = scopeProjectId(argv);
  if (project) return `ChatGPT Project Chats: ${project}`;
  return "ChatGPT Project Chats";
}

function scopeFlagText(argv) {
  if (hasFlag(argv, "--all")) return " --all";
  const project = scopeProjectId(argv);
  return project ? ` --project ${JSON.stringify(project)}` : "";
}

function formatChatList(chats, argv = []) {
  const lines = [color("1;36", `Recent ${scopeLabel(argv)}`), ""];
  if (!chats.length) {
    lines.push("No chats found.");
    return lines.join("\n");
  }
  for (const [index, chat] of chats.entries()) {
    lines.push(`${index + 1}. ${conversationTitle(chat)}`);
    lines.push(`   id: ${chat.id}`);
    lines.push(`   updated: ${formatDate(chat.update_time || chat.create_time)}`);
    if (chat.snippet) lines.push(`   snippet: ${truncate(chat.snippet, 96)}`);
    lines.push("");
  }
  lines.push("Resume:");
  lines.push(`  npm run resume --${scopeFlagText(argv)} 1`);
  lines.push("  npm run resume -- <conversation-id>");
  return lines.join("\n").trimEnd();
}

function formatSearchResults(results, query, argv = []) {
  const lines = [color("1;36", "ChatGPT Chat Search"), ""];
  lines.push(`Query: ${query}`);
  lines.push(`Scope: ${scopeLabel(argv)}`);
  lines.push("");
  if (!results.length) {
    lines.push("No matching chats found.");
    return lines.join("\n");
  }
  for (const [index, result] of results.entries()) {
    const item = sanitizeSearchResult(result);
    lines.push(`${index + 1}. ${item.title || "Untitled chat"}`);
    lines.push(`   id: ${item.conversation_id}`);
    lines.push(`   updated: ${formatDate(item.update_time ? item.update_time * 1000 : null)}`);
    if (item.snippet) lines.push(`   match: ${truncate(item.snippet, 120)}`);
    lines.push("");
  }
  lines.push("Resume:");
  lines.push(`  npm run resume --${scopeFlagText(argv)} --search ${JSON.stringify(query)}`);
  lines.push("Export:");
  lines.push(`  npm run transcript --${scopeFlagText(argv)} --search ${JSON.stringify(query)}`);
  return lines.join("\n").trimEnd();
}

function formatJobList(jobs) {
  const lines = [color("1;36", "Second Braincell Jobs"), ""];
  if (!jobs.length) {
    lines.push("No jobs found.");
    return lines.join("\n");
  }
  for (const [index, job] of jobs.entries()) {
    lines.push(`${index + 1}. ${job.id}`);
    lines.push(`   kind: ${job.kind}`);
    lines.push(`   status: ${job.status}`);
    lines.push(`   created: ${formatDate(job.createdAt)}`);
    if (job.conversationId) lines.push(`   conversation: ${job.conversationId}`);
    if (job.responseLength) lines.push(`   response: ${job.responseLength} chars`);
    lines.push("");
  }
  lines.push("JSON:");
  lines.push("  npm run chatgpt -- jobs --json");
  return lines.join("\n").trimEnd();
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
        ? `Async ${kind} job submitted and background watcher started. Create a thread heartbeat automation with a ${kind === "image" ? "30-second" : "10-minute"} interval to report completion when available, then do not poll or wait unless explicitly asked.`
        : undefined,
      heartbeatAutomation: isAsync
        ? {
            requiredWhenAvailable: true,
            kind: "heartbeat",
            destination: "thread",
            intervalSeconds: kind === "image" ? 30 : 600,
            rrule: kind === "image" ? "FREQ=SECONDLY;INTERVAL=30" : "FREQ=MINUTELY;INTERVAL=10",
            name: kind === "image" ? "Check ChatGPT image job" : "Check ChatGPT Deep Research job",
            prompt: `In ${ROOT_DIR}, check Second Braincell job ${job.id} with npm run status -- ${job.id}. If it is complete, report the artifact path and render the image/report when possible. If it is still waiting, check again later without extra commentary.`,
          }
        : undefined,
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

function withoutFlags(argv, names) {
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

function ensureFlag(argv, name, value = null) {
  if (argv.includes(name)) return argv;
  return value === null ? [...argv, name] : [...argv, name, String(value)];
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

function applyModelPreset(argv, { defaultModel = DEFAULT_TEXT_MODEL } = {}) {
  let requestedModel = getFlag(argv, "--model", defaultModel);
  let requestedReasoning = getFlag(argv, "--reasoning", getFlag(argv, "--thinking-effort", undefined));
  const requestedWasBest = normalizeModelName(requestedModel) === "best";
  if (requestedWasBest) {
    const best = resolveBestModelFromCache();
    requestedModel = best.modelName;
    requestedReasoning = requestedReasoning || best.reasoning;
  }
  const resolved = resolveModelPreset({ modelName: requestedModel, reasoning: requestedReasoning });
  let next = withoutFlags(argv, ["--model", "--reasoning", "--thinking-effort"]);
  if (resolved.model) next = ensureFlag(next, "--model", resolved.model);
  if (resolved.thinkingEffort) next = ensureFlag(next, "--thinking-effort", resolved.thinkingEffort);
  if (resolved.presetName) next = ensureFlag(next, "--model-preset", resolved.presetName);
  if (requestedWasBest) next = ensureFlag(next, "--model-selection", "best");
  return next;
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
  const kind = getFlag(argv, "--kind", "message");
  if (!["message", "image", "deep-research"].includes(kind)) throw new Error("--kind must be message, image, or deep-research");
  const asyncByDefault = kind !== "message" && !hasFlag(argv, "--sync");
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
    nextArgv = withoutFlags(nextArgv, ["--model", "--reasoning", "--thinking-effort"]);
    await runDirectApiMessage([
      ...nextArgv,
      "--job-kind",
      "api-image",
      "--output-kind",
      "image",
      "--kind",
      "image",
      "--quality",
      getFlag(argv, "--quality", "high"),
    ]);
    return;
  }

  if (kind === "deep-research") {
    const modeledArgv = hasFlag(argv, "--model") || hasFlag(argv, "--reasoning") || hasFlag(argv, "--thinking-effort") ? applyModelPreset(nextArgv, { defaultModel: undefined }) : nextArgv;
    await runDirectApiMessage([...modeledArgv, "--job-kind", "api-deep-research", "--kind", "deep-research"]);
    return;
  }

  await runDirectApiMessage(applyModelPreset(nextArgv));
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

function formatConversationSummary(summary) {
  const lines = [color("1;36", summary.title || "Untitled Chat"), ""];
  lines.push(`Conversation ID: ${summary.conversationId}`);
  lines.push(`Messages: ${summary.messageCount}`);
  if (summary.updateTime) lines.push(`Updated: ${formatDate(summary.updateTime)}`);
  if (summary.firstUserMessage) {
    lines.push("");
    lines.push(color("1", "Started With"));
    lines.push(summary.firstUserMessage);
  }
  if (summary.latestAssistantMessage) {
    lines.push("");
    lines.push(color("1", "Latest ChatGPT Response"));
    lines.push(summary.latestAssistantMessage);
  }
  if (summary.recentMessages.length) {
    lines.push("");
    lines.push(color("1", "Recent Messages"));
    for (const message of summary.recentMessages) {
      lines.push(`- ${message.role}: ${message.text}`);
    }
  }
  return lines.join("\n");
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

function firstPositionalIndex(argv) {
  const valueFlags = new Set([
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
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    if (valueFlags.has(argv[i])) {
      i += 1;
      continue;
    }
    if (!String(argv[i]).startsWith("--")) return i;
  }
  return -1;
}

function firstPositionalArg(argv) {
  const index = firstPositionalIndex(argv);
  return index === -1 ? undefined : argv[index];
}

function splitSelectorArg(argv, command) {
  const index = firstPositionalIndex(argv);
  if (index === -1) throw new Error(`${command} requires a chat number, ChatGPT conversation id, or Second Braincell job id.`);
  return {
    selector: argv[index],
    rest: [...argv.slice(0, index), ...argv.slice(index + 1)],
  };
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

export async function updateApiJobStatus(job) {
  if (!job.conversationId) return updateJob(job, { status: "needs_user", warning: "No conversation id captured for API job." });
  const headers = job.options?.curlPath ? loadCurlTemplate(job.options.curlPath).headers : loadLocalHeaders();
  const history = await fetchConversation(headers, job.conversationId);
  const responsePath = resolve(JOBS_DIR, job.id, "response.md");

  if (job.options?.outputKind === "image" || job.kind === "api-image") {
    const pointers = findImageAssetPointers(history);
    if (!pointers.length) {
      return updateJob(job, { status: "waiting", asyncStatus: history.async_status || null, message: "No image asset pointer yet." });
    }
    ensureDir(IMAGES_DIR);
    const imagePath = uniquePath(IMAGES_DIR, job.id, ".png");
    const downloaded = await downloadGeneratedImage({ headers, assetPointer: pointers.at(-1).asset_pointer, outPath: imagePath });
    job.artifacts.image = imagePath;
    job.artifacts.imageContentType = downloaded.contentType;
    job.artifacts.chatTitle = history.title;
    return updateJob(job, { status: "completed", asyncStatus: history.async_status || null, message: undefined });
  }

  if (job.kind === "api-deep-research") {
    const report = deepResearchReportFromConversation(history);
    if (!report.text) {
      delete job.artifacts.responseMarkdown;
      return updateJob(job, {
        status: report.status === "failed" ? "failed" : "waiting",
        asyncStatus: history.async_status || null,
        deepResearchStatus: report.status || null,
        message: report.status ? `Deep Research status: ${report.status}; no report text yet.` : "No Deep Research report text yet.",
      });
    }
    writeFileSync(responsePath, `${report.text}\n`);
    job.artifacts.responseMarkdown = responsePath;
    job.artifacts.chatTitle = history.title;
    if (report.reportMessageId) job.artifacts.reportMessageId = report.reportMessageId;
    return updateJob(job, {
      status: "completed",
      responseLength: report.text.length,
      asyncStatus: history.async_status || null,
      deepResearchStatus: report.status || null,
      message: undefined,
    });
  }

  const text = latestAssistantTextFromConversation(history);
  if (!text) {
    delete job.artifacts.responseMarkdown;
    return updateJob(job, { status: "waiting", asyncStatus: history.async_status || null, message: "No assistant text yet." });
  }
  writeFileSync(responsePath, `${text}\n`);
  job.artifacts.responseMarkdown = responsePath;
  job.artifacts.chatTitle = history.title;
  return updateJob(job, { status: "completed", responseLength: text.length, asyncStatus: history.async_status || null, message: undefined });
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
