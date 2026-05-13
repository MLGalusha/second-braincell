#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJob, listJobs, loadJob, saveJob, updateJob } from "./jobs.js";
import { IMAGES_DIR, JOBS_DIR } from "./config.js";
import { ensureDir, getFlag, getFlags, hasFlag, readTextArg, uniquePath } from "./util.js";
import { DEFAULT_TEXT_MODEL, capabilities, resolveModelPreset } from "./model-presets.js";
import {
  downloadGeneratedImage,
  deepResearchReportFromConversation,
  fetchConversation,
  findImageAssetPointers,
  latestAssistantTextFromConversation,
  loadCurlTemplate,
  sendApiMessage,
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

async function runDirectApiMessage(argv) {
  const prompt = readTextArg(argv);
  const curlPath = getFlag(argv, "--curl", undefined);
  const model = getFlag(argv, "--model", undefined);
  const thinkingEffort = getFlag(argv, "--thinking-effort", undefined);
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
    options: { curlPath, model, thinkingEffort, modelPreset, outputKind, jobKind, kind, quality, attachFiles, watchIntervalSeconds, watchTimeoutSeconds },
  });

  try {
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

    console.log(
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
    );
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
      console.log(JSON.stringify(capabilities(), null, 2));
      return;
    }

    if (command === "ask") {
      await runAsk(argv);
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
      console.log(JSON.stringify(listJobs(Number(getFlag(argv, "--limit", 30))), null, 2));
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
