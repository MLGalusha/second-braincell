#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = resolve(dirname(__filename), "..");
const SOURCE_DIR = resolve(ROOT_DIR, "skills", "chatgpt-direct-api");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function codexHome() {
  return process.env.CODEX_HOME || resolve(homedir(), ".codex");
}

function targetDir() {
  return resolve(argValue("--target") || process.env.SECOND_BRAINCELL_SKILL_DIR || resolve(codexHome(), "skills", "chatgpt-direct-api"));
}

function validateSkill(path) {
  const skillPath = resolve(path, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`Missing SKILL.md in ${path}`);
  const text = readFileSync(skillPath, "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${skillPath} must start with YAML frontmatter.`);
  if (!/^name:\s*chatgpt-direct-api\s*$/m.test(text)) throw new Error(`${skillPath} is missing name: chatgpt-direct-api.`);
  if (!/^description:\s*\S/m.test(text)) throw new Error(`${skillPath} is missing a description.`);
}

function main() {
  const destination = targetDir();
  validateSkill(SOURCE_DIR);
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(SOURCE_DIR, destination, { recursive: true });
  writeFileSync(resolve(destination, "RUNNER_ROOT.txt"), `${ROOT_DIR}\n`);
  validateSkill(destination);
  console.log(
    JSON.stringify(
      {
        installed: true,
        source: SOURCE_DIR,
        destination,
        next: "Restart Codex or start a new Codex thread so the global skill metadata is reloaded.",
      },
      null,
      2,
    ),
  );
}

main();
