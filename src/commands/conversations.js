import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, resolve } from "node:path";
import { splitSelectorArg, withoutFlags, firstPositionalArg } from "../cli-args.js";
import {
  formatChatList,
  formatConversationSummary,
  formatSearchResults,
  sanitizeChatSummary,
  sanitizeSearchResult,
} from "../cli-formatters.js";
import { color } from "../cli-ui.js";
import { JOBS_DIR, OUTPUT_DIR } from "../config.js";
import {
  authRefreshMessage,
  fetchConversation,
  listAllConversations,
  listConversationsForProject,
  listProjectConversations,
  projectIdFromUrl,
  searchConversations,
} from "../chatgpt-api.js";
import { loadJob } from "../jobs.js";
import { loadLocalHeaders } from "../local-config.js";
import { displayPath, ensureDir, getFlag, hasFlag, readTextArg, slugify, uniquePath } from "../util.js";
import { applyModelPreset, isAuthExpiredResult } from "../model-capabilities.js";
import { runDirectApiMessage } from "./ask.js";

function transcriptDefaultPath() {
  return resolve(OUTPUT_DIR, "conversations", `conversation_${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
}

function appendTranscriptTurn(path, { turn, prompt, response, jobId, responsePath }) {
  appendFileSync(
    path,
    [
      `## Turn ${turn}`,
      "",
      "**User**",
      "",
      prompt.trim(),
      "",
      "**ChatGPT**",
      "",
      String(response || "").trim() || "(no response text)",
      "",
      `Job: \`${jobId}\``,
      responsePath ? `Response file: \`${responsePath}\`` : null,
      "",
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );
}

function conversationMessages(history) {
  return Object.values(history.mapping || {})
    .map((node) => node?.message)
    .filter((message) => {
      if (!message?.author?.role) return false;
      if (!["user", "assistant"].includes(message.author.role)) return false;
      if (message.metadata?.is_visually_hidden_from_conversation) return false;
      if (message.metadata?.chatgpt_sdk_suppressed_response) return false;
      if (message.metadata?.tool_invoked_message || message.metadata?.tool_invoking_message) return false;
      return Boolean((message.content?.parts || []).some((part) => typeof part === "string" && part.trim()));
    })
    .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
}

function transcriptFromConversation(history, conversationId) {
  const title = history.title || "ChatGPT Conversation";
  const lines = [`# ${title}`, "", `Conversation ID: \`${conversationId}\``, ""];
  for (const message of conversationMessages(history)) {
    const role = message.author.role === "assistant" ? "ChatGPT" : "User";
    const text = (message.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
    if (!text) continue;
    lines.push(`## ${role}`);
    lines.push("");
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function transcriptPathFor(history, conversationId, explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  const title = slugify(history.title || conversationId, "conversation").replace(/\s+/g, "-").toLowerCase();
  return uniquePath(resolve(OUTPUT_DIR, "conversations"), title, ".md");
}

function messageText(message) {
  return (message.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
}

function truncateMiddle(value, length = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= length) return text;
  const head = Math.floor((length - 20) * 0.6);
  const tail = length - 20 - head;
  return `${text.slice(0, head).trimEnd()} ... ${text.slice(-tail).trimStart()}`;
}

function conversationSummary(history, conversationId, { maxMessages = 8, maxChars = 900 } = {}) {
  const messages = conversationMessages(history);
  const firstUser = messages.find((message) => message.author.role === "user");
  const assistantMessages = messages.filter((message) => message.author.role === "assistant");
  const latestAssistant = assistantMessages.at(-1);
  const included = messages.slice(-maxMessages);
  return {
    conversationId,
    title: history.title || null,
    createTime: history.create_time || null,
    updateTime: history.update_time || null,
    messageCount: messages.length,
    firstUserMessage: firstUser ? truncateMiddle(messageText(firstUser), maxChars) : null,
    latestAssistantMessage: latestAssistant ? truncateMiddle(messageText(latestAssistant), maxChars) : null,
    recentMessages: included.map((message) => ({
      role: message.author.role === "assistant" ? "ChatGPT" : "User",
      text: truncateMiddle(messageText(message), maxChars),
    })),
  };
}

export function scopeProjectId(argv) {
  const project = getFlag(argv, "--project", undefined);
  if (project) return project;
  return undefined;
}

async function scopedChats(argv, { limit = 20 } = {}) {
  const headers = loadLocalHeaders();
  const project = scopeProjectId(argv);
  if (hasFlag(argv, "--all")) return listAllConversations(headers, { limit });
  if (project) return listConversationsForProject(headers, project, { limit });
  return listProjectConversations(headers, { limit });
}

function searchQueryArg(argv) {
  const flagged = getFlag(argv, "--search", getFlag(argv, "--query", undefined));
  if (flagged) return flagged;
  const positional = firstPositionalArg(argv);
  if (positional) return positional;
  throw new Error("Search query is required.");
}

async function scopedSearch(argv, { limit = 10 } = {}) {
  const headers = loadLocalHeaders();
  const project = scopeProjectId(argv);
  const useDefaultProject = !hasFlag(argv, "--all") && !project;
  const projectId = project || (useDefaultProject ? projectIdFromUrl() : undefined);
  const query = searchQueryArg(argv);
  const results = await searchConversations(headers, { query, limit, projectId });
  return { query, results };
}

async function resolveConversationFromSearch(argv, { limit = 10 } = {}) {
  const { query, results } = await scopedSearch(argv, { limit });
  const result = results[0];
  if (!result?.conversation_id) throw new Error(`No matching ChatGPT chats found for: ${query}`);
  return { conversationId: result.conversation_id, source: "search", result };
}

async function resolveConversationSelector(selector, { limit = 30, argv = [] } = {}) {
  if (!selector) throw new Error("Expected a chat number, ChatGPT conversation id, or Second Braincell job id.");

  if (/^\d+$/.test(selector)) {
    const chats = await scopedChats(argv, { limit });
    const chat = chats[Number(selector) - 1];
    if (!chat) throw new Error(`No recent chat at position ${selector}. Run \`npm run chats\` to see available chats.`);
    return { conversationId: chat.id, source: "recent-chat", chat };
  }

  if (existsSync(jobPathForSelector(selector))) {
    const job = loadJob(selector);
    if (!job.conversationId) throw new Error(`Job ${selector} has no ChatGPT conversation id.`);
    return { conversationId: job.conversationId, source: "job", job };
  }

  return { conversationId: selector, source: "conversation-id" };
}

function jobPathForSelector(selector) {
  return resolve(JOBS_DIR, selector, "job.json");
}

export async function runConverse(argv) {
  const kind = getFlag(argv, "--kind", "message");
  if (kind !== "message") throw new Error("converse currently supports text message conversations only.");

  const transcriptPath = resolve(getFlag(argv, "--transcript", transcriptDefaultPath()));
  ensureDir(dirname(transcriptPath));
  writeFileSync(transcriptPath, "# ChatGPT Conversation\n\n");

  const firstPrompt = getFlag(argv, "--prompt", undefined) || (hasFlag(argv, "--prompt-file") || hasFlag(argv, "--file") ? readTextArg(argv) : undefined);
  if (!firstPrompt && !process.stdin.isTTY) throw new Error("Provide --prompt or --prompt-file when stdin is not interactive.");
  const maxTurnsRaw = getFlag(argv, "--max-turns", undefined);
  const defaultMaxTurns = firstPrompt && !process.stdin.isTTY ? 1 : Infinity;
  const maxTurns = maxTurnsRaw === undefined ? defaultMaxTurns : Number(maxTurnsRaw);
  if (!Number.isFinite(maxTurns) && maxTurnsRaw !== undefined) throw new Error("--max-turns must be a number");
  if (maxTurns < 1) throw new Error("--max-turns must be at least 1");

  const baseArgv = withoutFlags(argv, ["--prompt", "--prompt-file", "--file", "--transcript", "--max-turns", "--continue-job", "--kind"]);
  const followupBaseArgv = withoutFlags(baseArgv, ["--attach-file"]);
  const rl = createInterface({ input, output });
  let prompt = firstPrompt || (await rl.question("First prompt: "));
  let continueJobId = getFlag(argv, "--continue-job", undefined);
  let turn = 1;

  try {
    while (prompt.trim() && !["/end", "end", "/done", "done"].includes(prompt.trim().toLowerCase()) && turn <= maxTurns) {
      const turnArgv = [...(turn === 1 ? baseArgv : followupBaseArgv), "--prompt", prompt];
      if (continueJobId) turnArgv.push("--continue-job", continueJobId);
      const result = await runDirectApiMessage(applyModelPreset(turnArgv), { silent: true });
      appendTranscriptTurn(transcriptPath, {
        turn,
        prompt,
        response: result.response,
        jobId: result.id,
        responsePath: result.responsePath,
      });

      console.log("");
      console.log(color("1;36", `Turn ${turn} complete`));
      console.log(`Job: ${result.id}`);
      console.log(`Transcript: ${transcriptPath}`);
      console.log("");
      console.log(result.response || "(no response text)");
      console.log("");

      if (isAuthExpiredResult(result)) throw new Error(result.message || authRefreshMessage());
      if (!result.ok) throw new Error(`Turn ${turn} failed with status ${result.status}`);
      continueJobId = result.id;
      turn += 1;
      if (turn > maxTurns) break;
      prompt = await rl.question("Next prompt (blank or /end to end): ");
    }
  } finally {
    rl.close();
  }

  console.log(
    JSON.stringify(
      {
        completedTurns: turn - 1,
        latestJobId: continueJobId,
        transcriptPath,
      },
      null,
      2,
    ),
  );
}

export async function runChats(argv) {
  const limit = Number(getFlag(argv, "--limit", 20));
  if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit must be a positive number");
  const chats = await scopedChats(argv, { limit });
  if (hasFlag(argv, "--json") || hasFlag(argv, "--detailed")) {
    console.log(JSON.stringify(chats.map(sanitizeChatSummary), null, 2));
  } else {
    console.log(formatChatList(chats, argv));
  }
}

export async function runSearchChats(argv) {
  const limit = Number(getFlag(argv, "--limit", 10));
  if (!Number.isFinite(limit) || limit < 1) throw new Error("--limit must be a positive number");
  const { query, results } = await scopedSearch(argv, { limit });
  if (hasFlag(argv, "--json") || hasFlag(argv, "--detailed")) {
    console.log(JSON.stringify(results.map(sanitizeSearchResult), null, 2));
  } else {
    console.log(formatSearchResults(results, query, argv));
  }
}

export async function runResume(argv) {
  let rest = argv;
  let resolved;
  if (hasFlag(argv, "--search") || hasFlag(argv, "--query")) {
    resolved = await resolveConversationFromSearch(argv, { limit: Number(getFlag(argv, "--limit", 10)) || 10 });
  } else {
    const split = splitSelectorArg(argv, "resume");
    rest = split.rest;
    resolved = await resolveConversationSelector(split.selector, { limit: Number(getFlag(rest, "--limit", 30)) || 30, argv: rest });
  }
  await runConverse([...rest, "--conversation-id", resolved.conversationId]);
}

export async function runTranscript(argv) {
  let rest = argv;
  let resolved;
  if (hasFlag(argv, "--search") || hasFlag(argv, "--query")) {
    resolved = await resolveConversationFromSearch(argv, { limit: Number(getFlag(argv, "--limit", 10)) || 10 });
  } else {
    const split = splitSelectorArg(argv, "transcript");
    rest = split.rest;
    resolved = await resolveConversationSelector(split.selector, { limit: Number(getFlag(rest, "--limit", 30)) || 30, argv: rest });
  }
  const history = await fetchConversation(loadLocalHeaders(), resolved.conversationId);
  const markdown = transcriptFromConversation(history, resolved.conversationId);

  if (hasFlag(rest, "--print")) {
    console.log(markdown.trimEnd());
    return;
  }

  const outPath = transcriptPathFor(history, resolved.conversationId, getFlag(rest, "--out", undefined));
  ensureDir(dirname(outPath));
  writeFileSync(outPath, markdown);
  const payload = {
    conversationId: resolved.conversationId,
    title: history.title || null,
    messages: conversationMessages(history).length,
    transcriptPath: outPath,
    displayPath: displayPath(outPath),
  };
  if (hasFlag(rest, "--json") || hasFlag(rest, "--detailed")) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(color("1;36", "Transcript exported"));
    console.log("");
    console.log(`Title: ${payload.title || "Untitled chat"}`);
    console.log(`Messages: ${payload.messages}`);
    console.log(`Path: ${payload.displayPath}`);
  }
}

export async function runChatSummary(argv) {
  let rest = argv;
  let resolved;
  if (hasFlag(argv, "--search") || hasFlag(argv, "--query")) {
    resolved = await resolveConversationFromSearch(argv, { limit: Number(getFlag(argv, "--limit", 10)) || 10 });
  } else {
    const split = splitSelectorArg(argv, "chat-summary");
    rest = split.rest;
    resolved = await resolveConversationSelector(split.selector, { limit: Number(getFlag(rest, "--limit", 30)) || 30, argv: rest });
  }
  const history = await fetchConversation(loadLocalHeaders(), resolved.conversationId);
  const summary = conversationSummary(history, resolved.conversationId, {
    maxMessages: Number(getFlag(rest, "--max-messages", 8)) || 8,
    maxChars: Number(getFlag(rest, "--max-chars", 900)) || 900,
  });
  if (hasFlag(rest, "--json") || hasFlag(rest, "--detailed")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatConversationSummary(summary));
  }
}
