#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { capabilities } from "./model-presets.js";
import { formatHumanCapabilities } from "./cli-formatters.js";
import { hasFlag } from "./util.js";
import { usage } from "./usage.js";
import { runAsk, runApiDeepResearch, runApiImage, runDirectApiMessage } from "./commands/ask.js";
import { runSetup } from "./commands/connect.js";
import { runModelCheck } from "./commands/model-check.js";
import {
  runChats,
  runChatSummary,
  runConverse,
  runResume,
  runSearchChats,
  runTranscript,
} from "./commands/conversations.js";
import { runProjectInstructions } from "./commands/project-instructions.js";
import { jobResultPath, runJobs, runResult, runStatus } from "./commands/jobs.js";
import { loadJob } from "./jobs.js";

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  try {
    if (!command || command === "help" || command === "--help") {
      console.log(usage());
      return;
    }

    if (command === "connect" || command === "setup") {
      await runSetup(argv);
      return;
    }

    if (command === "capabilities") {
      const data = capabilities();
      if (hasFlag(argv, "--detailed") || hasFlag(argv, "--json")) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatHumanCapabilities(data));
      }
      return;
    }

    if (command === "model-check") {
      await runModelCheck(argv);
      return;
    }

    if (command === "ask") {
      await runAsk(argv);
      return;
    }

    if (command === "converse") {
      await runConverse(argv);
      return;
    }

    if (command === "chats") {
      await runChats(argv);
      return;
    }

    if (command === "search-chats") {
      await runSearchChats(argv);
      return;
    }

    if (command === "project-instructions") {
      await runProjectInstructions(argv);
      return;
    }

    if (command === "resume") {
      await runResume(argv);
      return;
    }

    if (command === "transcript") {
      await runTranscript(argv);
      return;
    }

    if (command === "chat-summary") {
      await runChatSummary(argv);
      return;
    }

    if (command === "api-message") {
      await runDirectApiMessage(argv);
      return;
    }

    if (command === "api-deep-research") {
      await runApiDeepResearch(argv);
      return;
    }

    if (command === "api-image") {
      await runApiImage(argv);
      return;
    }

    if (command === "api-status" || command === "status") {
      await runStatus(command, argv);
      return;
    }

    if (command === "jobs") {
      runJobs(argv);
      return;
    }

    if (command === "result") {
      runResult(argv);
      return;
    }

    if (existsSync(jobResultPath(command))) {
      console.log(JSON.stringify(loadJob(command), null, 2));
      return;
    }

    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  } catch (error) {
    console.error(error?.code === "CHATGPT_AUTH_EXPIRED" ? error.message : String(error.stack || error.message || error));
    process.exit(1);
  }
}

if (process.argv[1] === __filename) main();
