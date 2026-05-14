import { resolve } from "node:path";
import { updateApiJobStatus } from "../async-jobs.js";
import { authRefreshMessage } from "../chatgpt-api.js";
import { formatJobList } from "../cli-formatters.js";
import { JOBS_DIR } from "../config.js";
import { listJobs, loadJob, updateJob } from "../jobs.js";
import { getFlag, hasFlag } from "../util.js";

export async function runStatus(command, argv) {
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
}

export function runJobs(argv) {
  const jobs = listJobs(Number(getFlag(argv, "--limit", 30)));
  if (hasFlag(argv, "--json") || hasFlag(argv, "--detailed")) {
    console.log(JSON.stringify(jobs, null, 2));
  } else {
    console.log(formatJobList(jobs));
  }
}

export function runResult(argv) {
  const id = argv[0];
  if (!id) throw new Error("result requires a job id");
  console.log(JSON.stringify(loadJob(id), null, 2));
}

export function jobResultPath(command) {
  return resolve(JOBS_DIR, command, "job.json");
}
