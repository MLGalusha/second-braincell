import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deepResearchReportFromConversation,
  downloadGeneratedImage,
  fetchConversation,
  findImageAssetPointers,
  latestAssistantTextFromConversation,
  loadCurlTemplate,
} from "./chatgpt-api.js";
import { IMAGES_DIR, JOBS_DIR, ROOT_DIR } from "./config.js";
import { updateJob } from "./jobs.js";
import { loadLocalHeaders } from "./local-config.js";
import { ensureDir, uniquePath } from "./util.js";

const ASYNC_HEARTBEAT_AUTOMATION = {
  image: {
    label: "1-minute",
    intervalSeconds: 60,
    rrule: "FREQ=MINUTELY;INTERVAL=1",
    name: "Check ChatGPT image job",
  },
  "deep-research": {
    label: "10-minute",
    intervalSeconds: 600,
    rrule: "FREQ=MINUTELY;INTERVAL=10",
    name: "Check ChatGPT Deep Research job",
  },
};

export function asyncJobHeartbeatLabel(kind) {
  return ASYNC_HEARTBEAT_AUTOMATION[kind]?.label || ASYNC_HEARTBEAT_AUTOMATION["deep-research"].label;
}

export function heartbeatAutomationForAsyncJob(jobId, kind) {
  const schedule = ASYNC_HEARTBEAT_AUTOMATION[kind] || ASYNC_HEARTBEAT_AUTOMATION["deep-research"];
  return {
    requiredWhenAvailable: true,
    kind: "heartbeat",
    destination: "thread",
    intervalSeconds: schedule.intervalSeconds,
    rrule: schedule.rrule,
    name: schedule.name,
    prompt: `In ${ROOT_DIR}, check Second Braincell job ${jobId} with npm run status -- ${jobId}. If it is complete, report the artifact path and render the image/report when possible. If it is still waiting, check again later without extra commentary.`,
  };
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
