import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { formatAlreadyConnected } from "../cli-formatters.js";
import { color } from "../cli-ui.js";
import { getFlag, hasFlag } from "../util.js";
import { localSetupStatus, readCurlInputFile, writeLocalSetup } from "../local-config.js";

const SETUP_FILTER = "conversation";
const CONNECT_CURL_FALLBACK = "Use `--curl-file`, `--curl`, or pipe the cURL on stdin.";

function setupTitle(title) {
  console.log("");
  console.log(color("1;36", `== ${title} ==`));
}

function setupSteps(steps, start = 1) {
  for (const [index, step] of steps.entries()) {
    console.log(`  ${start + index}. ${step}`);
  }
}

async function promptSetupValue(question) {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function waitForClipboard(label) {
  const prompt = color("1;33", `After copying the ${label}, press Enter. No need to paste. `);
  await promptSetupValue(prompt);
  return await readClipboard();
}

function linuxClipboardInstallPlan() {
  if (process.platform !== "linux") return null;
  const wayland = Boolean(process.env.WAYLAND_DISPLAY);
  const helper = wayland ? "wl-clipboard" : "xclip";
  const candidates = [
    { manager: "apt-get", args: ["sudo", "apt-get", "install", "-y", helper] },
    { manager: "apt", args: ["sudo", "apt", "install", "-y", helper] },
    { manager: "dnf", args: ["sudo", "dnf", "install", "-y", helper] },
    { manager: "pacman", args: ["sudo", "pacman", "-S", "--needed", helper] },
    { manager: "zypper", args: ["sudo", "zypper", "install", "-y", helper] },
  ];
  for (const candidate of candidates) {
    try {
      execFileSync("which", [candidate.manager], { stdio: "ignore" });
      return { helper, installCommand: candidate.args };
    } catch {
      // Try the next package manager.
    }
  }
  return null;
}

async function maybeInstallLinuxClipboardHelper() {
  const plan = linuxClipboardInstallPlan();
  if (!plan || !process.stdin.isTTY) return false;
  const commandText = plan.installCommand.join(" ");
  const answer = (await promptSetupValue(`No Linux clipboard helper found. Install ${plan.helper} now with \`${commandText}\`? [y/N] `)).trim().toLowerCase();
  if (!["y", "yes"].includes(answer)) return false;
  const result = spawnSync(plan.installCommand[0], plan.installCommand.slice(1), { stdio: "inherit" });
  return result.status === 0;
}

function clipboardCommands() {
  return (
    process.platform === "darwin"
      ? [["pbpaste"]]
      : process.platform === "win32"
        ? [["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"]]
        : [
            ["wl-paste", "--no-newline"],
            ["xclip", "-selection", "clipboard", "-out"],
            ["xsel", "--clipboard", "--output"],
          ]
  );
}

function readClipboardOnce() {
  const commands = clipboardCommands();
  for (const [command, ...args] of commands) {
    try {
      const value = execFileSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 }).trim();
      if (value) return value;
    } catch {
      // Try the next platform clipboard command.
    }
  }
  return null;
}

async function readClipboard() {
  const first = readClipboardOnce();
  if (first) return first;
  if (process.platform === "linux" && (await maybeInstallLinuxClipboardHelper())) {
    const afterInstall = readClipboardOnce();
    if (afterInstall) return afterInstall;
  }
  throw new Error(
    process.platform === "linux"
      ? `Could not read the clipboard. Install one clipboard helper such as \`wl-clipboard\`, \`xclip\`, or \`xsel\`, or ${CONNECT_CURL_FALLBACK}`
      : `Could not read the clipboard. ${CONNECT_CURL_FALLBACK}`,
  );
}

export async function runSetup(argv) {
  let projectUrl = getFlag(argv, "--project-url", undefined);
  let curlText = getFlag(argv, "--curl", undefined);
  const curlFile = getFlag(argv, "--curl-file", undefined);
  if (curlFile) curlText = readCurlInputFile(curlFile);
  const force = hasFlag(argv, "--force");
  const hasExplicitCurlInput = Boolean(curlText || curlFile);
  const existing = localSetupStatus();
  if (existing.ready && !force && !hasExplicitCurlInput) {
    if (!process.stdout.isTTY) {
      console.log(
        JSON.stringify(
          {
            ready: true,
            alreadyConnected: true,
            authPath: existing.auth.path,
            configPath: existing.config.path,
            projectId: existing.config.projectId,
            reconnect: "npm run connect -- --force",
            status: "npm run capabilities",
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(formatAlreadyConnected(existing));
    return;
  }
  const interactive = process.stdin.isTTY && !curlText && !curlFile;
  if (interactive) {
    console.log(color("1", "\nSecond Braincell connect"));
    console.log("This connection step reads from your clipboard after you press Enter. Anything typed or pasted at these prompts is ignored.");
  }
  if (!curlText && process.stdin.isTTY) {
    setupTitle("Copy one authenticated Project cURL");
    setupSteps([
      "Open ChatGPT and create a Project named `Codex` if you do not already have one.",
      "Before creating a new Project, click the settings button and set Project memory to project-only.",
      "Open the ChatGPT Project in the browser.",
      "Right-click the ChatGPT page and click Inspect.",
      "In DevTools, click the Network tab.",
      "Click the clear network log button in the top-left of Network: ⊘",
      "Click the Network filter box directly below that clear button.",
      `Type this filter into that box: ${SETUP_FILTER}`,
      "While the Network tab is open, go back to your ChatGPT Project and send a message.",
      "A request named `conversation` should appear in the Network table. Its icon is an orange square with <> inside it.",
      "Right-click the `conversation` request and choose Copy > Copy as cURL.",
    ]);
    curlText = await waitForClipboard("cURL");
  }
  if (!curlText && !process.stdin.isTTY) curlText = readFileSync(0, "utf8");
  const status = writeLocalSetup({ projectUrl, curlText });
  const summary = {
    ready: status.ready,
    authPath: status.auth.path,
    configPath: status.config.path,
    projectId: status.config.projectId,
    next: "npm run capabilities",
  };
  if (!process.stdout.isTTY) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  setupTitle("Connection complete");
  console.log(`  Ready: ${color("32", String(summary.ready))}`);
  console.log(`  Project ID: ${summary.projectId}`);
  console.log(`  Config: ${summary.configPath}`);
  console.log(`  Auth: ${summary.authPath}`);
  console.log("");
  console.log(color("1", "Next:"));
  console.log("  1. Go to your Codex agent.");
  console.log("  2. Tell it: Read and follow `skills/chatgpt-direct-api/SKILL.md`.");
  console.log('  3. Test it: Use the ChatGPT direct API runner to ask "Reply with exactly: agent works".');
  console.log("");
  console.log(color("1", "Manual smoke test:"));
  console.log('  npm run ask -- --sync --prompt "Reply with exactly: clone works"');
}
