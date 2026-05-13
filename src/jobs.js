import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { JOBS_DIR } from "./config.js";
import { ensureDir, jobId, nowIso, writeJson } from "./util.js";

export function createJob({ kind, prompt, options }) {
  ensureDir(JOBS_DIR);
  const id = jobId(kind);
  const dir = resolve(JOBS_DIR, id);
  mkdirSync(dir, { recursive: true });
  const job = {
    id,
    kind,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    promptPath: resolve(dir, "prompt.md"),
    artifacts: {},
    options,
    log: [],
  };
  writeFileSync(job.promptPath, `${prompt.trim()}\n`);
  saveJob(job);
  return { job, dir };
}

export function jobPath(id) {
  return resolve(JOBS_DIR, id, "job.json");
}

export function loadJob(id) {
  const path = jobPath(id);
  if (!existsSync(path)) throw new Error(`Unknown job: ${id}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveJob(job) {
  job.updatedAt = nowIso();
  writeJson(jobPath(job.id), job);
}

export function updateJob(job, patch) {
  Object.assign(job, patch);
  saveJob(job);
  return job;
}

export function logJob(job, message, data = undefined) {
  job.log.push({
    at: nowIso(),
    message,
    ...(data === undefined ? {} : { data }),
  });
  saveJob(job);
}

export function listJobs(limit = 30) {
  ensureDir(JOBS_DIR);
  return readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return loadJob(entry.name);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
