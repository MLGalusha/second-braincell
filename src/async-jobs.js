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

export function imageJobWaitingPatch(history) {
  return { status: "waiting", asyncStatus: history.async_status || null, message: "No image asset pointer yet." };
}

export function imageJobCompletedPatch({ history, imagePath, contentType }) {
  return {
    patch: { status: "completed", asyncStatus: history.async_status || null, message: undefined },
    artifacts: {
      image: imagePath,
      imageContentType: contentType,
      chatTitle: history.title,
    },
  };
}

export function deepResearchJobPatch({ history, report, responsePath }) {
  if (!report.text) {
    return {
      patch: {
        status: report.status === "failed" ? "failed" : "waiting",
        asyncStatus: history.async_status || null,
        deepResearchStatus: report.status || null,
        message: report.status ? `Deep Research status: ${report.status}; no report text yet.` : "No Deep Research report text yet.",
      },
      clearArtifacts: ["responseMarkdown"],
    };
  }

  return {
    patch: {
      status: "completed",
      responseLength: report.text.length,
      asyncStatus: history.async_status || null,
      deepResearchStatus: report.status || null,
      message: undefined,
    },
    artifacts: {
      responseMarkdown: responsePath,
      chatTitle: history.title,
      ...(report.reportMessageId ? { reportMessageId: report.reportMessageId } : {}),
    },
    responseText: report.text,
  };
}

export function textJobPatch({ history, text, responsePath }) {
  if (!text) {
    return {
      patch: { status: "waiting", asyncStatus: history.async_status || null, message: "No assistant text yet." },
      clearArtifacts: ["responseMarkdown"],
    };
  }

  return {
    patch: { status: "completed", responseLength: text.length, asyncStatus: history.async_status || null, message: undefined },
    artifacts: {
      responseMarkdown: responsePath,
      chatTitle: history.title,
    },
    responseText: text,
  };
}

function applyJobTransition(job, transition) {
  for (const key of transition.clearArtifacts || []) delete job.artifacts[key];
  Object.assign(job.artifacts, transition.artifacts || {});
  return updateJob(job, transition.patch);
}

export async function updateApiJobStatus(job) {
  if (!job.conversationId) return updateJob(job, { status: "needs_user", warning: "No conversation id captured for API job." });
  const headers = job.options?.curlPath ? loadCurlTemplate(job.options.curlPath).headers : loadLocalHeaders();
  const history = await fetchConversation(headers, job.conversationId);
  const responsePath = resolve(JOBS_DIR, job.id, "response.md");

  if (job.options?.outputKind === "image" || job.kind === "api-image") {
    const pointers = findImageAssetPointers(history);
    if (!pointers.length) {
      return updateJob(job, imageJobWaitingPatch(history));
    }
    ensureDir(IMAGES_DIR);
    const imagePath = uniquePath(IMAGES_DIR, job.id, ".png");
    const downloaded = await downloadGeneratedImage({ headers, assetPointer: pointers.at(-1).asset_pointer, outPath: imagePath });
    return applyJobTransition(job, imageJobCompletedPatch({ history, imagePath, contentType: downloaded.contentType }));
  }

  if (job.kind === "api-deep-research") {
    const report = deepResearchReportFromConversation(history);
    const transition = deepResearchJobPatch({ history, report, responsePath });
    if (transition.responseText) writeFileSync(responsePath, `${transition.responseText}\n`);
    return applyJobTransition(job, transition);
  }

  const text = latestAssistantTextFromConversation(history);
  const transition = textJobPatch({ history, text, responsePath });
  if (transition.responseText) writeFileSync(responsePath, `${transition.responseText}\n`);
  return applyJobTransition(job, transition);
}
