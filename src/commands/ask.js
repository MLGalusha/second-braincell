import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { asyncJobHeartbeatLabel, heartbeatAutomationForAsyncJob, updateApiJobStatus } from "../async-jobs.js";
import { normalizeAskArgv } from "../cli-args.js";
import { JOBS_DIR } from "../config.js";
import { createJob, loadJob, saveJob } from "../jobs.js";
import { getFlag, getFlags, hasFlag, readTextArg } from "../util.js";
import { authRefreshMessage, loadCurlTemplate, sendApiMessage, uploadFile } from "../chatgpt-api.js";
import { loadLocalHeaders } from "../local-config.js";
import {
  isAuthExpiredResult,
  isModelUnavailableResult,
  markModelCapability,
  modelAttemptsForBest,
  modelUnavailableMessageForResult,
  resolveBestModelFromCache,
} from "../model-capabilities.js";

export async function runDirectApiMessage(argv, { silent = false } = {}) {
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

export async function runAsk(argv) {
  await runDirectApiMessage(normalizeAskArgv(argv, { resolveBestModel: resolveBestModelFromCache }));
}

export async function runApiDeepResearch(argv) {
  await runDirectApiMessage([...argv, "--job-kind", "api-deep-research", "--kind", "deep-research"]);
}

export async function runApiImage(argv) {
  await runDirectApiMessage([...argv, "--output-kind", "image", "--kind", "image"]);
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
