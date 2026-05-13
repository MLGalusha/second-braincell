#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultShimPath, defaultSkillTargetDir, ROOT_DIR } from "./paths.js";
import { localSetupStatus } from "../src/local-config.js";

function statusLine(ok, label, detail = "") {
  return `${ok ? "OK " : "ERR"} ${label}${detail ? ` - ${detail}` : ""}`;
}

function nodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

function pathHasShim(shimPath) {
  const dir = dirname(shimPath);
  return String(process.env.PATH || "").split(delimiter).includes(dir);
}

function runSbcCapabilities(shimPath) {
  if (!existsSync(shimPath)) return { ok: false, detail: "sbc shim is not installed" };
  const result = spawnSync(shimPath, ["capabilities", "--detailed"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) return { ok: false, detail: (result.stderr || result.stdout || "command failed").trim() };
  try {
    const json = JSON.parse(result.stdout);
    return { ok: Boolean(json.setup?.ready), detail: json.setup?.ready ? "capabilities command works" : "connection incomplete" };
  } catch {
    return { ok: false, detail: "capabilities output was not JSON" };
  }
}

function main() {
  const skillDir = defaultSkillTargetDir();
  const shimPath = defaultShimPath();
  const runnerRootPath = resolve(skillDir, "RUNNER_ROOT.txt");
  const setup = localSetupStatus();
  const checks = [];

  checks.push({ ok: nodeMajor() >= 18, label: "Node.js", detail: process.version });
  checks.push({ ok: existsSync(resolve(ROOT_DIR, "package.json")), label: "runner root", detail: ROOT_DIR });
  checks.push({ ok: existsSync(resolve(skillDir, "SKILL.md")), label: "global skill", detail: skillDir });
  checks.push({ ok: existsSync(runnerRootPath), label: "skill runner root pointer", detail: existsSync(runnerRootPath) ? readFileSync(runnerRootPath, "utf8").trim() : "missing" });
  checks.push({ ok: existsSync(shimPath), label: "sbc shim", detail: shimPath });
  checks.push({ ok: pathHasShim(shimPath), label: "sbc shim directory on PATH", detail: dirname(shimPath) });
  checks.push({ ok: setup.auth.ready, label: "local auth", detail: setup.auth.exists ? ".local/auth.json present" : "run npm run connect" });
  checks.push({ ok: setup.config.ready, label: "local project config", detail: setup.config.projectId || "run npm run connect" });
  checks.push(runSbcCapabilities(shimPath));
  checks.at(-1).label = "sbc capabilities";

  const ok = checks.every((check) => check.ok);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    console.log("Second Braincell Doctor\n");
    for (const check of checks) console.log(statusLine(check.ok, check.label, check.detail));
    console.log("");
    console.log(ok ? "Ready." : "One or more checks failed. Run npm run install-global, then npm run connect if auth/config is missing.");
  }
  process.exit(ok ? 0 : 1);
}

main();
