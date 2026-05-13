#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultSkillTargetDir, ROOT_DIR, SKILL_SOURCE_DIR } from "./paths.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function targetDir() {
  return resolve(argValue("--target") || process.env.SECOND_BRAINCELL_SKILL_DIR || defaultSkillTargetDir());
}

function validateSkill(path) {
  const skillPath = resolve(path, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`Missing SKILL.md in ${path}`);
  const text = readFileSync(skillPath, "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${skillPath} must start with YAML frontmatter.`);
  if (!/^name:\s*chatgpt-direct-api\s*$/m.test(text)) throw new Error(`${skillPath} is missing name: chatgpt-direct-api.`);
  if (!/^description:\s*\S/m.test(text)) throw new Error(`${skillPath} is missing a description.`);
}

export function installSkill({ destination = targetDir() } = {}) {
  validateSkill(SKILL_SOURCE_DIR);
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(SKILL_SOURCE_DIR, destination, { recursive: true });
  writeFileSync(resolve(destination, "RUNNER_ROOT.txt"), `${ROOT_DIR}\n`);
  validateSkill(destination);
  return {
    installed: true,
    source: SKILL_SOURCE_DIR,
    destination,
    next: "Restart Codex or start a new Codex thread so the global skill metadata is reloaded.",
  };
}

function main() {
  const result = installSkill();
  console.log(
    JSON.stringify(
      result,
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
