function color(code, value) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return value;
  return `\x1b[${code}m${value}\x1b[0m`;
}

function checkmark(value) {
  return value ? color("32", "✓") : color("31", "✗");
}

function featureLine(label, ready) {
  return `  ${checkmark(ready)} ${label}`;
}

export function formatAlreadyConnected(setup) {
  const lines = [];
  lines.push(color("1;36", "Second Braincell"));
  lines.push("");
  lines.push(`Status: ${color("32", "already connected")}`);
  if (setup?.config?.projectId) lines.push(`Project ID: ${setup.config.projectId}`);
  if (setup?.config?.path) lines.push(`Config: ${setup.config.path}`);
  if (setup?.auth?.path) lines.push(`Auth: ${setup.auth.path}`);
  lines.push("");
  lines.push("To reconnect with a fresh ChatGPT cURL:");
  lines.push("  npm run connect -- --force");
  lines.push("");
  lines.push("For the full status:");
  lines.push("  npm run capabilities");
  return lines.join("\n");
}

export function formatHumanCapabilities(data) {
  const lines = [];
  const setup = data.setup;
  const projectName = setup.config.projectId || "configured project";

  lines.push(color("1;36", "Second Braincell"));
  lines.push("");
  lines.push(`Status: ${setup.ready ? color("32", "ready") : color("31", "connection incomplete")}`);
  if (setup.config.ready) {
    lines.push(`Project: ${projectName || "configured"}`);
    lines.push(`Project ID: ${setup.config.projectId}`);
  }
  lines.push("");

  if (!setup.ready) {
    lines.push("Missing:");
    if (!setup.auth.ready) lines.push(featureLine(".local/auth.json", false));
    if (!setup.config.ready) lines.push(featureLine(".local/config.json", false));
    for (const hint of setup.hints || []) lines.push(`  - ${hint}`);
    lines.push("");
    lines.push("Next step:");
    lines.push("  npm run connect");
    lines.push("");
  }

  lines.push("Capabilities:");
  lines.push(featureLine("Text conversations", data.readiness.message));
  lines.push(featureLine("File and PDF questions", data.readiness.attachments));
  lines.push(featureLine("Image generation: high", data.readiness.imageHigh));
  lines.push(featureLine("Image generation: instant", data.readiness.imageInstant));
  lines.push(featureLine("Deep Research", data.readiness.deepResearch));
  lines.push("");

  lines.push("Default commands:");
  lines.push('  npm run converse -- --prompt "Have a conversation with ChatGPT about this decision."');
  lines.push("  npm run chats");
  lines.push('  npm run search-chats -- "observability roadmap"');
  lines.push("  npm run chatgpt -- project-instructions");
  lines.push("  npm run resume -- 1");
  lines.push("  npm run transcript -- 1");
  lines.push('  npm run ask -- --attach-file ./document.pdf --prompt "Answer questions about this file."');
  lines.push('  npm run ask -- --kind image --prompt "A red cube on a white table."');
  lines.push('  npm run ask -- --kind deep-research --prompt "Research this topic."');
  lines.push("");
  lines.push("Detailed JSON:");
  lines.push("  npm run capabilities -- --detailed");

  return lines.join("\n");
}

export function formatDate(value) {
  if (!value) return "unknown";
  const normalized = typeof value === "number" && value > 0 && value < 1000000000000 ? value * 1000 : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function truncate(value, length = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function conversationTitle(chat) {
  return chat?.title || chat?.snippet || "Untitled chat";
}

export function sanitizeChatSummary(chat) {
  return {
    id: chat.id,
    title: chat.title || null,
    create_time: chat.create_time || null,
    update_time: chat.update_time || null,
    is_archived: Boolean(chat.is_archived),
    is_temporary_chat: Boolean(chat.is_temporary_chat),
    memory_scope: chat.memory_scope || null,
    async_status: chat.async_status || null,
    snippet: chat.snippet || null,
  };
}

export function sanitizeSearchResult(result) {
  return {
    conversation_id: result.conversation_id,
    title: result.title || null,
    update_time: result.update_time || null,
    is_archived: Boolean(result.is_archived),
    snippet: result.payload?.snippet || null,
    message_id: result.payload?.message_id || null,
  };
}

function scopeProjectId(argv) {
  const index = argv.indexOf("--project");
  return index === -1 ? undefined : argv[index + 1];
}

function scopeLabel(argv) {
  if (argv.includes("--all")) return "All ChatGPT Chats";
  const project = scopeProjectId(argv);
  if (project) return `ChatGPT Project Chats: ${project}`;
  return "ChatGPT Project Chats";
}

function scopeFlagText(argv) {
  if (argv.includes("--all")) return " --all";
  const project = scopeProjectId(argv);
  return project ? ` --project ${JSON.stringify(project)}` : "";
}

export function formatChatList(chats, argv = []) {
  const lines = [color("1;36", `Recent ${scopeLabel(argv)}`), ""];
  if (!chats.length) {
    lines.push("No chats found.");
    return lines.join("\n");
  }
  for (const [index, chat] of chats.entries()) {
    lines.push(`${index + 1}. ${conversationTitle(chat)}`);
    lines.push(`   id: ${chat.id}`);
    lines.push(`   updated: ${formatDate(chat.update_time || chat.create_time)}`);
    if (chat.snippet) lines.push(`   snippet: ${truncate(chat.snippet, 96)}`);
    lines.push("");
  }
  lines.push("Resume:");
  lines.push(`  npm run resume --${scopeFlagText(argv)} 1`);
  lines.push("  npm run resume -- <conversation-id>");
  return lines.join("\n").trimEnd();
}

export function formatSearchResults(results, query, argv = []) {
  const lines = [color("1;36", "ChatGPT Chat Search"), ""];
  lines.push(`Query: ${query}`);
  lines.push(`Scope: ${scopeLabel(argv)}`);
  lines.push("");
  if (!results.length) {
    lines.push("No matching chats found.");
    return lines.join("\n");
  }
  for (const [index, result] of results.entries()) {
    const item = sanitizeSearchResult(result);
    lines.push(`${index + 1}. ${item.title || "Untitled chat"}`);
    lines.push(`   id: ${item.conversation_id}`);
    lines.push(`   updated: ${formatDate(item.update_time ? item.update_time * 1000 : null)}`);
    if (item.snippet) lines.push(`   match: ${truncate(item.snippet, 120)}`);
    lines.push("");
  }
  lines.push("Resume:");
  lines.push(`  npm run resume --${scopeFlagText(argv)} --search ${JSON.stringify(query)}`);
  lines.push("Export:");
  lines.push(`  npm run transcript --${scopeFlagText(argv)} --search ${JSON.stringify(query)}`);
  return lines.join("\n").trimEnd();
}

export function formatJobList(jobs) {
  const lines = [color("1;36", "Second Braincell Jobs"), ""];
  if (!jobs.length) {
    lines.push("No jobs found.");
    return lines.join("\n");
  }
  for (const [index, job] of jobs.entries()) {
    lines.push(`${index + 1}. ${job.id}`);
    lines.push(`   kind: ${job.kind}`);
    lines.push(`   status: ${job.status}`);
    lines.push(`   created: ${formatDate(job.createdAt)}`);
    if (job.conversationId) lines.push(`   conversation: ${job.conversationId}`);
    if (job.responseLength) lines.push(`   response: ${job.responseLength} chars`);
    lines.push("");
  }
  lines.push("JSON:");
  lines.push("  npm run chatgpt -- jobs --json");
  return lines.join("\n").trimEnd();
}

export function formatConversationSummary(summary) {
  const lines = [color("1;36", summary.title || "Untitled Chat"), ""];
  lines.push(`Conversation ID: ${summary.conversationId}`);
  lines.push(`Messages: ${summary.messageCount}`);
  if (summary.updateTime) lines.push(`Updated: ${formatDate(summary.updateTime)}`);
  if (summary.firstUserMessage) {
    lines.push("");
    lines.push(color("1", "Started With"));
    lines.push(summary.firstUserMessage);
  }
  if (summary.latestAssistantMessage) {
    lines.push("");
    lines.push(color("1", "Latest ChatGPT Response"));
    lines.push(summary.latestAssistantMessage);
  }
  if (summary.recentMessages.length) {
    lines.push("");
    lines.push(color("1", "Recent Messages"));
    for (const message of summary.recentMessages) {
      lines.push(`- ${message.role}: ${message.text}`);
    }
  }
  return lines.join("\n");
}
