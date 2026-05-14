import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fetchProjectResource, projectIdFromUrl, updateProjectInstructions } from "../chatgpt-api.js";
import { color } from "../cli-ui.js";
import { OUTPUT_DIR } from "../config.js";
import { loadLocalHeaders } from "../local-config.js";
import { displayPath, ensureDir, getFlag, hasFlag, uniquePath } from "../util.js";
import { scopeProjectId } from "./conversations.js";

function projectInstructionsBackupPath(projectId) {
  return uniquePath(resolve(OUTPUT_DIR, "project-instructions"), `${projectId}_${new Date().toISOString().replace(/[:.]/g, "-")}`, ".md");
}

function projectSummary(resource) {
  const gizmo = resource.gizmo || {};
  return {
    projectId: gizmo.id,
    name: gizmo.display?.name || null,
    instructions: gizmo.instructions || "",
    instructionsLength: (gizmo.instructions || "").length,
    memoryScope: gizmo.memory_scope || null,
    updatedAt: gizmo.updated_at || null,
  };
}

export async function runProjectInstructions(argv) {
  const projectId = scopeProjectId(argv) || projectIdFromUrl();
  if (!projectId) throw new Error("No ChatGPT Project ID configured. Run `npm run connect` first.");
  const headers = loadLocalHeaders();

  const setText = getFlag(argv, "--set", undefined);
  const setFile = getFlag(argv, "--set-file", undefined);
  const outPath = getFlag(argv, "--out", undefined);

  if (setText !== undefined || setFile !== undefined) {
    if (setText !== undefined && setFile !== undefined) throw new Error("Use either --set or --set-file, not both.");
    const nextInstructions = setFile !== undefined ? readFileSync(resolve(setFile), "utf8").trimEnd() : setText;
    const current = await fetchProjectResource(headers, projectId);
    const before = projectSummary(current);
    if (!hasFlag(argv, "--yes")) {
      console.log(color("1;36", "Project instructions update preview"));
      console.log("");
      console.log(`Project: ${before.name || projectId}`);
      console.log(`Project ID: ${projectId}`);
      console.log(`Current length: ${before.instructionsLength}`);
      console.log(`New length: ${nextInstructions.length}`);
      console.log("");
      console.log("No changes were made. Re-run with --yes to update.");
      return;
    }

    const backupPath = projectInstructionsBackupPath(projectId);
    ensureDir(dirname(backupPath));
    writeFileSync(backupPath, before.instructions ? `${before.instructions}\n` : "");
    const updated = await updateProjectInstructions(headers, { projectId, instructions: nextInstructions });
    const after = projectSummary(updated.result.resource || (await fetchProjectResource(headers, projectId)));
    console.log(
      JSON.stringify(
        {
          projectId,
          name: after.name,
          previousLength: before.instructionsLength,
          newLength: after.instructionsLength,
          backupPath,
          displayPath: displayPath(backupPath),
        },
        null,
        2,
      ),
    );
    return;
  }

  const resource = await fetchProjectResource(headers, projectId);
  const summary = projectSummary(resource);
  if (outPath) {
    const absolute = resolve(outPath);
    ensureDir(dirname(absolute));
    writeFileSync(absolute, summary.instructions ? `${summary.instructions}\n` : "");
    console.log(
      JSON.stringify(
        {
          projectId,
          name: summary.name,
          instructionsLength: summary.instructionsLength,
          path: absolute,
          displayPath: displayPath(absolute),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (hasFlag(argv, "--json") || hasFlag(argv, "--detailed")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(color("1;36", "ChatGPT Project Instructions"));
  console.log("");
  console.log(`Project: ${summary.name || projectId}`);
  console.log(`Project ID: ${projectId}`);
  console.log(`Length: ${summary.instructionsLength}`);
  console.log("");
  console.log(summary.instructions || "(no Project instructions set)");
}
