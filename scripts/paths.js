import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_SOURCE_DIR = resolve(ROOT_DIR, "skills", "chatgpt-direct-api");

export function codexHome() {
  return process.env.CODEX_HOME || resolve(homedir(), ".codex");
}

export function defaultSkillTargetDir() {
  return resolve(codexHome(), "skills", "chatgpt-direct-api");
}

export function defaultBinDir() {
  return resolve(homedir(), ".local", "bin");
}

export function defaultShimPath() {
  return resolve(defaultBinDir(), "sbc");
}
