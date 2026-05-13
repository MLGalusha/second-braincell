#!/usr/bin/env node
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { installSkill } from "./install-skill.js";
import { defaultShimPath, ROOT_DIR } from "./paths.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function shimPath() {
  return resolve(argValue("--shim") || process.env.SECOND_BRAINCELL_SHIM || defaultShimPath());
}

export function installShim({ destination = shimPath() } = {}) {
  const source = resolve(ROOT_DIR, "bin", "sbc.js");
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { force: true });
  try {
    symlinkSync(source, destination);
  } catch {
    writeFileSync(destination, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(source)} "$@"\n`);
  }
  chmodSync(destination, 0o755);
  const linked = existsSync(destination) && lstatSync(destination).isSymbolicLink();
  return { installed: true, destination, source, linked };
}

function main() {
  const skill = installSkill();
  const shim = installShim();
  console.log(
    JSON.stringify(
      {
        installed: true,
        skill,
        shim,
        next: `Make sure ${dirname(shim.destination)} is on PATH, then use: sbc capabilities`,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
