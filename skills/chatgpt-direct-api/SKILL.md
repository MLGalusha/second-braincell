---
name: chatgpt-direct-api
description: Use when Codex should ask ChatGPT through the local Second Braincell runner, use a ChatGPT Project conversation, search or resume ChatGPT chats, upload files/PDFs to ChatGPT, generate images, run Deep Research, or inspect/update ChatGPT Project instructions from any repository.
metadata:
  short-description: Use Second Braincell to talk to ChatGPT
---

# Second Braincell

Use this skill from any local repository to send prompts, files, images, or Deep Research tasks through Second Braincell.

## Rules

- Use the direct API CLI. Do not use Playwright, Chrome UI automation, or browser clicking for normal ChatGPT requests.
- Keep `.local/` private. It contains auth headers and must not be printed, committed, copied into docs, or included in outputs.
- Keep generated artifacts in ignored `output/`.
- Do not print cookies, auth headers, proof tokens, signed upload URLs, HARs, cURLs, file ids, or account identifiers.

## Runner Root

Before running commands, resolve the Second Braincell repo root:

1. If the current working directory's `package.json` has `"name": "second-braincell"`, use the current directory.
2. Else if `SECOND_BRAINCELL_HOME` is set, use that path.
3. Else if this installed skill directory contains `RUNNER_ROOT.txt`, read the repo root from that file.
4. Else ask the user to run `npm run install-skill` from the cloned Second Braincell repo.

Prefer the global `sbc` command when it is available:

```bash
sbc capabilities
sbc converse --prompt "..."
```

If `sbc` is not available, and the runner root differs from the current project, run commands with `npm --prefix "$SBC_ROOT" run <script> -- ...`. For example:

```bash
npm --prefix "$SBC_ROOT" run capabilities
npm --prefix "$SBC_ROOT" run converse -- --prompt "..."
```

## Connect

Check setup first:

```bash
sbc capabilities
```

This prints a human-readable readiness summary. Use `sbc capabilities --detailed` when structured debug JSON is needed.

If connection is missing, ask the user to run:

```bash
sbc connect
```

Connect is clipboard-based. Tell the user to create a new ChatGPT Project named `Codex`, click the settings button before creating it, and set Project memory to project-only. Then they should open that Project, right-click the ChatGPT page, click Inspect, open DevTools Network, clear the network log button in the top-left of Network (`⊘`), click the Network filter box directly below it, type `conversation`, send a short Project message, right-click the `conversation` request with the orange square `<>` icon, choose Copy > Copy as cURL, and press Enter in connect. There is no need to paste into the terminal; connect reads from the clipboard and ignores typed or pasted prompt input. The runner stores extracted headers in `.local/auth.json` and the extracted Project ID in `.local/config.json`.

If a command returns `needs_connect` or says the ChatGPT session credentials expired, ask the user to run `npm run connect` again and copy a fresh authenticated Project conversation cURL.

## Commands

Send a text prompt or start a response-aware conversation:

```bash
sbc converse --prompt "..."
```

Use `converse` as the default path for normal text chat, including one-question requests. It prints ChatGPT's response after each turn, keeps a combined transcript under `output/conversations/`, and continues the same ChatGPT thread until you end with a blank prompt, `/end`, `end`, `/done`, or `done`. If `converse` is run non-interactively with `--prompt`, it sends one turn and exits.

List recent ChatGPT Project chats:

```bash
sbc chats
```

Default chat listing and search are scoped to the configured ChatGPT Project. Only use `--all` or another Project when the user explicitly asks to find, inspect, summarize, export, or resume a chat outside the configured Project.

Search ChatGPT chats with ChatGPT's native search:

```bash
sbc search-chats "observability roadmap"
sbc search-chats --all "observability roadmap"
```

For simple questions about what an old chat was about, fetch a lightweight local summary instead of exporting Markdown:

```bash
npm run chat-summary -- --search "observability roadmap"
npm run chat-summary -- --all --search "observability roadmap"
```

Use `chat-summary` when the user asks to find, identify, or briefly explain a prior chat. Use `transcript` only when the user asks to export the chat, quote/review the full conversation, or discuss the old chat in depth with Codex.

Read or update the configured ChatGPT Project instructions:

```bash
npm run project-instructions
npm run project-instructions -- --set-file ./instructions.md
npm run project-instructions -- --set-file ./instructions.md --yes
```

Instruction updates require `--yes` and create a local backup first. Do not update Project instructions unless the user explicitly asks to change them.

Resume a previous ChatGPT Project chat by recent-chat number, conversation id, or local job id:

```bash
npm run resume -- 1 --prompt "Pick this back up."
npm run resume -- --search "observability roadmap" --prompt "Continue this thread."
```

Export a previous ChatGPT Project chat to Markdown:

```bash
npm run transcript -- 1
npm run transcript -- --search "observability roadmap"
```

For lower-level one-shot calls or scripted continuation, `ask` remains available:

```bash
npm run ask -- --prompt "First message."
npm run ask -- --continue-job <previous-job-id> --prompt "Follow-up message."
npm run ask -- --continue-job <latest-job-id> --prompt "Another follow-up."
```

Use the most recent returned job id for each follow-up. The runner reuses the stored `conversation_id` and fetches the latest parent message id from ChatGPT before sending. If you already have a ChatGPT conversation id, use `--conversation-id <id>`; if you also know the exact parent node, use `--parent-message-id <id>`.

When asked to "chat back and forth with ChatGPT", "have a conversation", "send a follow-up", or otherwise continue context, prefer `npm run converse`. If using `ask` directly, always use `--continue-job` after the first request. Do not simulate continuity by pasting a transcript into a new prompt, and do not put labels like `Codex:` and `ChatGPT:` into a new prompt as a substitute for threading.

## Prompt Style

When having a multi-message conversation with ChatGPT, send natural user-facing messages. Do not include narrator framing, turn labels, or delegation disclaimers unless the user explicitly asks for them. The prompt should be only what ChatGPT should respond to in that moment.

Avoid prompts like:

```text
I'm Codex, acting on behalf of Bob. Let's have a brief three-turn conversation. Turn 1: pick a practical software/product topic...
Turn 2: We see the usual problem...
```

Prefer prompts like:

```text
Pick a practical software/product topic you think is worth discussing this week, explain why it matters, and ask me one focused follow-up question.
We see the usual problem: logs, metrics, and traces exist, but they are fragmented across tools, too noisy, and rarely tied cleanly to product impact. What would you do first to make observability more useful without turning it into a large platform project?
Assume the stack is Datadog, Sentry, OpenTelemetry, and scattered product analytics. Give me a crisp final recommendation: one first-week plan, one metric that proves this is helping, and one anti-pattern to avoid.
```

Use `converse` or `--continue-job` for continuity; do not encode the turn number or conversation mechanics into the prompt.

## Models

Default to ChatGPT `auto` mode unless the user asks for a specific model.

```bash
npm run ask -- --prompt "..."
npm run ask -- --model auto --prompt "..."
npm run ask -- --model instant --prompt "..."
npm run ask -- --model thinking --reasoning standard --prompt "..."
npm run ask -- --model thinking --reasoning extended --prompt "..."
npm run ask -- --model pro --reasoning standard --prompt "..."
npm run ask -- --model pro --reasoning extended --prompt "..."
npm run ask -- --model 5.3 --prompt "..."
npm run ask -- --model best --prompt "..."
```

Model meanings:

- `auto`: ChatGPT's Auto mode; this is the default.
- `instant`: GPT-5.5 Instant.
- `thinking`: GPT-5.5 Thinking with `standard` or `extended`.
- `pro`: GPT-5.5 Pro with `standard` or `extended`, only when the signed-in account has access.
- `5.3`: GPT-5.3 Instant legacy fallback.
- `best`: use cached model-check results, preferring `pro extended`, then `thinking extended`, `thinking standard`, `instant`, `5.3`, and `auto`.

Run a model check when connection changes or when model availability matters:

```bash
npm run model-check
npm run model-check -- --model pro
```

If the user explicitly asks for `pro` and it is unavailable, report that clearly instead of silently falling back. Use `best` only when the user asks for the best available model or allows fallback. Do not use `light` or `heavy`; local endpoint tests returned HTTP 422 for those reasoning values.

Ask about a file:

```bash
npm run ask -- --attach-file ./file.pdf --prompt "..."
```

Generate an image:

```bash
npm run ask -- --kind image --quality high --prompt "..."
npm run ask -- --kind image --quality instant --prompt "..."
```

Run Deep Research:

```bash
npm run ask -- --kind deep-research --prompt "..."
```

Refresh a job:

```bash
npm run status -- <job-id>
```

Normal text chat is synchronous by default. Image generation and Deep Research are async by default.

Default agent behavior for image generation and Deep Research is fire-and-forget: run the submit command, create a thread heartbeat automation when available, confirm the job was submitted, then end the response or move to the user's next task. Creating the heartbeat is required in Codex sessions with automation support. Use a 1-minute heartbeat for image jobs and a 10-minute heartbeat for Deep Research jobs. Do not use the Deep Research 10-minute heartbeat schedule for image jobs. The submit command starts the background watcher.

Do not run `status`, `watch-api-job`, sleep loops, polling loops, or wait for the artifact unless the user explicitly asks to wait, check progress, retrieve the result, debug the watcher, or use `--sync`.

Use the printed status command or `npm run watch-api-job -- <job-id> --once` only when a manual check is explicitly requested.
