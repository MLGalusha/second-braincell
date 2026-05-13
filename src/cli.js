#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, listJobs, loadJob, saveJob, updateJob } from "./jobs.js";
import { IMAGES_DIR, JOBS_DIR, OUTPUT_DIR } from "./config.js";
import { displayPath, ensureDir, getFlag, getFlags, hasFlag, readTextArg, slugify, uniquePath } from "./util.js";
import { DEFAULT_TEXT_MODEL, capabilities, resolveModelPreset } from "./model-presets.js";
import {
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
const SETUP_FILTER = "/backend-api/f/conversation";

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
  const prompt = color("1;33", `Copy ${label}, then press Enter. No need to paste. `);
  await promptSetupValue(prompt);
  return readClipboard();
}

function usage() {
  return `
Usage:
  npm run chatgpt -- ask --prompt "..."
  npm run chatgpt -- setup
  npm run chatgpt -- ask --kind image --quality high --prompt "..."
  npm run chatgpt -- ask --kind deep-research --prompt "..."
  npm run chatgpt -- converse --prompt "Start a conversation..."
  npm run chatgpt -- chats
  npm run chatgpt -- search-chats "query"
  npm run chatgpt -- project-instructions
  npm run chatgpt -- resume <chat-number|conversation-id|job-id> --prompt "..."
  npm run chatgpt -- transcript <chat-number|conversation-id|job-id>
  npm run chatgpt -- status <job-id>
  npm run chatgpt -- capabilities
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
  --reasoning light|standard|heavy|extended
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
  lines.push(`Status: ${setup.ready ? color("32", "ready") : color("31", "setup incomplete")}`);
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
    lines.push("  npm run setup");
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
  const date = new Date(value);
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

function readClipboard() {
  try {
    return execFileSync("pbpaste", { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 }).trim();
  } catch {
    throw new Error("Could not read the clipboard with `pbpaste`. Use `--project-url` and `--curl-file`, or pipe the cURL on stdin.");
  }
}

async function runSetup(argv) {
  let projectUrl = getFlag(argv, "--project-url", undefined);
  let curlText = getFlag(argv, "--curl", undefined);
  const curlFile = getFlag(argv, "--curl-file", undefined);
  if (curlFile) curlText = readCurlInputFile(curlFile);
  const interactive = process.stdin.isTTY && !projectUrl && !curlText && !curlFile;
  if (interactive) {
    console.log(color("1", "\nSecond Braincell setup"));
    console.log("This setup reads from your clipboard after you press Enter. Anything typed or pasted at these prompts is ignored.");
  }
  if (!projectUrl && process.stdin.isTTY) {
    setupTitle("1. Create the ChatGPT Project");
    setupSteps([
      "Open ChatGPT and start creating a new Project.",
      "Name the Project `Codex`.",
      "Before creating it, click the settings button.",
      "Set Project memory to project-only. This cannot be changed after the Project is created.",
      "Create and open that Project in the browser.",
      "Copy the Project URL from the browser address bar.",
    ]);
    projectUrl = await waitForClipboard("the Project URL");
  }
  if (!curlText && process.stdin.isTTY) {
    setupTitle("2. Copy one authenticated cURL");
    setupSteps([
      "In the same ChatGPT Project page, right-click the page and click Inspect.",
      "In DevTools, click the Network tab.",
      "Click the clear network log button in the top-left of Network: ⊘",
      "Click the Network filter box directly below that clear button.",
      `Paste this filter into that box: ${SETUP_FILTER}`,
      "While the Network tab is open, go back to your ChatGPT Project and send a message.",
      "A request named `conversation` should appear in the Network table. Its icon is an orange square with <> inside it.",
      "Right-click the `conversation` request and choose Copy > Copy as cURL.",
    ]);
    curlText = await waitForClipboard("Copy as cURL");
  }
  if (!curlText && !process.stdin.isTTY) curlText = readFileSync(0, "utf8");
  if (!projectUrl) throw new Error("Missing project URL. Run `npm run setup -- --project-url <url>` when piping a cURL on stdin.");
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
  setupTitle("Setup complete");
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
  const model = getFlag(argv, "--model", undefined);
  const thinkingEffort = getFlag(argv, "--thinking-effort", undefined);
  const continueJobId = getFlag(argv, "--continue-job", undefined);
  let conversationId = getFlag(argv, "--conversation-id", undefined);
  const parentMessageId = getFlag(argv, "--parent-message-id", undefined);
  const modelPreset = getFlag(argv, "--model-preset", undefined);
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
    const result = await sendApiMessage({
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
    job.status = result.ok && !result.errorSeen ? (isAsync ? "submitted" : "completed") : "failed";
    job.statusCode = result.status;
    job.contentType = result.contentType;
    job.conversationId = result.conversationId;
    job.finishSeen = result.finishSeen;
    job.errorSeen = result.errorSeen;
    job.eventTypes = result.eventTypes;
    job.responseLength = result.responseText?.length || 0;
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
            prompt: `In /Users/masongalusha/Workspace/projects/second-braincell, check Second Braincell job ${job.id} with npm run status -- ${job.id}. If it is complete, report the artifact path and render the image/report when possible. If it is still waiting, check again later without extra commentary.`,
          }
        : undefined,
    };
    if (!silent) console.log(JSON.stringify(payload, null, 2));
    return payload;
  } catch (error) {
    job.status = "failed";
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

function applyModelPreset(argv, { defaultModel = DEFAULT_TEXT_MODEL } = {}) {
  const requestedModel = getFlag(argv, "--model", defaultModel);
  const requestedReasoning = getFlag(argv, "--reasoning", getFlag(argv, "--thinking-effort", undefined));
  const resolved = resolveModelPreset({ modelName: requestedModel, reasoning: requestedReasoning });
  let next = withoutFlags(argv, ["--model", "--reasoning", "--thinking-effort"]);
  if (resolved.model) next = ensureFlag(next, "--model", resolved.model);
  if (resolved.thinkingEffort) next = ensureFlag(next, "--thinking-effort", resolved.thinkingEffort);
  if (resolved.presetName) next = ensureFlag(next, "--model-preset", resolved.presetName);
  return next;
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

async function runProjectInstructions(argv) {
  const projectId = scopeProjectId(argv) || projectIdFromUrl();
  if (!projectId) throw new Error("No ChatGPT Project ID configured. Run `npm run setup` first.");
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

    if (command === "setup") {
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
      const job = await updateApiJobStatus(loadJob(id));
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
    console.error(String(error.stack || error.message || error));
    process.exit(1);
  }
}

if (process.argv[1] === __filename) main();
