#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { updateApiJobStatus } from "../src/async-jobs.js";
import { loadJob } from "../src/jobs.js";
import { getFlag, hasFlag, writeJson } from "../src/util.js";

function usage() {
  return `
Usage:
  node scripts/watch-api-job.js <job-id> [--interval-seconds 120] [--timeout-seconds 7200] [--notify]
  node scripts/watch-api-job.js <job-id> --once

Behavior:
  - waiting: exits quietly with code 2 when --once is used
  - completed: prints JSON, optionally sends a desktop notification when available, exits 0
  - failed: prints JSON, optionally sends a desktop notification when available, exits 1
`.trim();
}

function notify(title, message) {
  if (process.platform !== "darwin") return;
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  spawnSync("osascript", ["-e", script], { stdio: "ignore" });
}

function summarize(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    asyncStatus: job.asyncStatus,
    message: job.message,
    responsePath: job.artifacts?.responseMarkdown,
    imagePath: job.artifacts?.image,
    chatTitle: job.artifacts?.chatTitle,
    updatedAt: job.updatedAt,
  };
}

async function check(jobId, { notifyOnDone = false } = {}) {
  const job = await updateApiJobStatus(loadJob(jobId));
  const summary = summarize(job);
  const outPath = resolve("output", "jobs", job.id, "watch-status.json");
  writeJson(outPath, summary);

  if (job.status === "completed") {
    if (notifyOnDone) notify("ChatGPT API job completed", job.artifacts?.responseMarkdown || job.artifacts?.image || job.id);
    console.log(JSON.stringify({ ...summary, watchStatusPath: outPath }, null, 2));
    return 0;
  }

  if (job.status === "failed") {
    if (notifyOnDone) notify("ChatGPT API job failed", job.id);
    console.log(JSON.stringify({ ...summary, error: job.error, watchStatusPath: outPath }, null, 2));
    return 1;
  }

  return 2;
}

async function main() {
  const [jobId, ...argv] = process.argv.slice(2);
  if (!jobId || hasFlag(argv, "--help")) {
    console.log(usage());
    return;
  }

  const once = hasFlag(argv, "--once");
  const notifyOnDone = hasFlag(argv, "--notify");
  const intervalSeconds = Number(getFlag(argv, "--interval-seconds", 120));
  const timeoutSeconds = Number(getFlag(argv, "--timeout-seconds", 7200));
  const started = Date.now();

  while (true) {
    const code = await check(jobId, { notifyOnDone });
    if (code !== 2) process.exit(code);
    if (once) process.exit(2);
    if (Date.now() - started > timeoutSeconds * 1000) {
      const job = loadJob(jobId);
      const summary = summarize(job);
      console.log(JSON.stringify({ ...summary, status: "timeout" }, null, 2));
      process.exit(3);
    }
    await delay(intervalSeconds * 1000);
  }
}

main().catch((error) => {
  console.error(String(error.stack || error.message || error));
  process.exit(1);
});
