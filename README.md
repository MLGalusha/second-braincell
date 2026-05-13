# Second Braincell

Give your Codex agent a second braincell: a local path into your own ChatGPT Project for conversations, research, files, images, and model responses.

Second Braincell lets Codex use ChatGPT as a real second workspace. Your agent can ask ChatGPT for a one-off answer, keep a multi-turn conversation open, hand off a Deep Research report, generate images, ask questions about uploaded files and PDFs, search and resume previous chats, or update the configured Project instructions.

## What You Can Do

Use Second Braincell when you want Codex to:

- **Ask ChatGPT for a second opinion:** architecture reviews, product tradeoffs, debugging plans, research summaries, naming ideas, or concise explanations.
- **Run real conversations:** keep a ChatGPT thread open across turns, continue from a local job id, or resume a previous ChatGPT conversation.
- **Use previous ChatGPT work:** search past ChatGPT chats, find the thread where you already discussed a topic, resume that conversation, or export the chat as Markdown for Codex to read.
- **Use ChatGPT's file retrieval:** upload PDFs and documents through ChatGPT's file flow and use its built-in retrieval instead of spending Codex tokens searching manually.
- **Create images:** submit high-quality or instant image-generation jobs and save the resulting image locally.
- **Run Deep Research:** start a Deep Research job, let it continue asynchronously, and collect the final report under `output/`.
- **Tune the Project itself:** read, back up, preview, update, or clear the configured ChatGPT Project instructions.

The point is not just to get another model response. The point is to give Codex a fast, local, agent-friendly way to use the ChatGPT product experience you already have configured: Project instructions, Project-scoped chats, uploaded files, image generation, Deep Research, and chat exports.

## Why This Is Useful

Second Braincell is built for the workflow where you already have a ChatGPT account and a dedicated ChatGPT Project, and you want Codex to use that Project without driving the browser UI.

Browser automation tools can do a similar handoff by opening ChatGPT, pasting prompts, attaching files, and waiting for the page to finish. Second Braincell takes a narrower path: it uses the same authenticated ChatGPT web session, but sends source-built requests to browser-observed ChatGPT web API endpoints instead of clicking through Chrome.

That shape gives it a different set of tradeoffs:

- **No browser driving:** no Playwright flow, DOM selectors, model-picker clicking, paste races, or tab reattach loop for normal text requests.
- **Project-native conversations:** requests land in the configured ChatGPT Project, so Project instructions, Project memory settings, chat history, search, resume, and chat export all matter.
- **ChatGPT-native files:** PDFs and files use ChatGPT's upload and processing flow instead of only pasting file text into a prompt.
- **Agent-friendly output:** jobs, chat exports, images, reports, and status files are written locally under ignored `output/` paths.
- **Simple connection:** one authenticated ChatGPT Project cURL provides the local configuration; `connect` extracts both auth headers and the Project ID.
- **Easy reconnect:** if the ChatGPT web session expires, jobs fail with `needs_connect` and tell the agent to run `npm run connect` again.

Second Braincell is intentionally smaller than a general model router. It does not try to support every model provider, fan out to multiple APIs, or become a replacement for dedicated prompt-bundling tools. It focuses on one job: give Codex a practical local path into your ChatGPT Project.

## How It Works

Second Braincell is a local Node.js CLI that your Codex agent can call with `npm run converse` for normal text conversations and `npm run ask` for lower-level jobs.

`npm run connect` captures two local-only pieces of information from one copied Project `conversation` cURL:

- your ChatGPT Project ID
- auth headers from your signed-in `chatgpt.com` session

Those are stored in ignored files:

- `.local/config.json`
- `.local/auth.json`

The copied cURL is not used as a request template. It only provides auth headers. The source code in this repo builds the actual request bodies for messages, images, Deep Research, and file attachments.

If the copied ChatGPT session expires later, reconnecting is the same flow: run `npm run connect`, copy a fresh Project `conversation` cURL, and continue using the same configured Project.

## Security Model

Second Braincell does not use an OpenAI API key. It uses auth headers from your signed-in ChatGPT web session.

That is convenient, but it is also the biggest risk in this project. A copied ChatGPT cURL, `.local/auth.json`, browser HAR, or raw auth header can contain live session credentials. Anyone who gets those credentials may be able to use your ChatGPT account as you until the session is invalidated or expires. Treat these values like active browser login credentials, not like harmless setup snippets.

This means:

- Do not paste cURLs, cookies, auth headers, HAR files, `.local/auth.json`, or generated job output into issues, pull requests, chat logs, docs, screenshots, or support requests.
- Do not run this in shared workspaces, public sandboxes, CI, remote dev containers, or machines where other users can read your files.
- Do not give untrusted agents or scripts access to this repo after connecting, because local access to `.local/auth.json` is enough to send authenticated ChatGPT requests.
- Prefer a dedicated ChatGPT Project for Second Braincell, with Project memory set to project-only before creation.
- Review generated `output/` files before sharing anything from them. Chat exports, reports, images, job JSON, and file answers can contain private prompts, account-derived data, signed URLs, file ids, or conversation content.
- If you suspect a leak, assume session compromise. In ChatGPT, use `Settings > Security > Log out all`, change your password if account access may be compromised, enable MFA if available, delete the leaked local files, remove leaked artifacts from any public place, and contact OpenAI support if you see suspicious activity or cannot regain control.

When Codex asks Second Braincell to do something, the runner:

1. Builds the right ChatGPT web API request body in source code.
2. Sends it to the ChatGPT Project using your local auth headers.
3. Creates a local job under `output/jobs/`.
4. Starts a watcher for async work like images and Deep Research.
5. Writes final text, reports, images, and job status into ignored `output/` files.

For file and PDF questions, the runner uses ChatGPT's upload flow: create the file, upload bytes to the signed URL, process the upload, and attach the resulting file id to the message. Signed URLs and file ids are not printed in normal output.

## Quick Start

```bash
git clone https://github.com/MLGalusha/second-braincell.git
cd second-braincell
npm install
npm run connect
```

`npm run connect` is interactive and clipboard-based. It walks you through:

- creating a ChatGPT Project named `Codex`
- setting Project memory to project-only before the Project is created
- opening DevTools Network and filtering by `conversation`
- copying one authenticated Project `conversation` request as cURL

No need to paste the copied cURL into the terminal. Connect reads from your clipboard after you press Enter, and anything typed or pasted at the prompt is ignored.

On Linux, if no clipboard helper is available, connect can offer to install one before falling back to `--curl-file`, `--curl`, or stdin.

If ChatGPT signs you out or the copied session expires, commands fail with a `needs_connect` job status and tell you to run `npm run connect` again. Reconnecting refreshes `.local/auth.json` while keeping the configured Project ID in `.local/config.json`.

Check readiness:

```bash
npm run capabilities
```

This prints a clean connection and feature summary. For the full debug JSON, run:

```bash
npm run capabilities -- --detailed
```

Check which ChatGPT models are available to the signed-in account:

```bash
npm run model-check
npm run model-check -- --model pro
```

This writes ignored local results to `.local/model-capabilities.json`. The `best` model alias uses that cache to choose the strongest available checked model.

## Use It From Codex

After connect is complete, go to your Codex agent and tell it:

```text
Read and follow skills/chatgpt-direct-api/SKILL.md.
Use Second Braincell to ask ChatGPT: Reply with exactly: agent works
```

If your agent supports installing repo skills, install the skill from `skills/chatgpt-direct-api/SKILL.md`. Otherwise, telling the agent to read that file is enough.

## Agent Prompting

When asking your agent to use Second Braincell, describe the conversation or task naturally:

```text
Use Second Braincell to ask ChatGPT whether we should split this service. Have it compare keeping billing, notifications, and background jobs together versus separating them, then bring back the strongest recommendation, migration risks, and the first reversible step.
```

```text
Use Second Braincell to ask ChatGPT for three product directions for Bob's field-service app. Have it challenge the weakest assumption behind each direction, rank them by expected learning per week, and bring back a concise transcript.
```

## Personalize The ChatGPT Project

Second Braincell sends requests into a ChatGPT Project you control, so you can edit that Project's instructions to shape how ChatGPT behaves for your agent.

For example, you can make ChatGPT act as a skeptical product partner, a senior architecture reviewer, a concise research assistant, or a document-analysis specialist. Those standing instructions apply whenever Codex uses Second Braincell with that Project.

Example Project instructions:

```text
You are my product strategy reviewer. Be direct, skeptical, and practical. Push back on vague ideas, identify hidden assumptions, and always end with the next concrete decision I need to make.
```

```text
When discussing software architecture, optimize for maintainability and operational simplicity. Prefer boring technology unless there is a clear reason not to. Call out migration risk, observability needs, and rollback plans.
```

```text
When reviewing PDFs or documents, extract the answer first, then cite the relevant section or page if available. Separate confirmed facts from assumptions.
```

```text
Respond in this format:
- Recommendation
- Why it matters
- Risks
- Next action
Keep each section short.
```

This makes Second Braincell more useful than a generic ChatGPT call: your Codex agent can use a Project that already knows the role, tone, and decision style you want.

## Output

- Text and Deep Research: `output/jobs/<job-id>/response.md`
- Conversation transcripts: `output/conversations/<name>.md`
- Project instruction backups: `output/project-instructions/<project-id>_<timestamp>.md`
- Images: `output/images/<job-id>.png`
- Job metadata: `output/jobs/<job-id>/job.json`
- Watcher status: `output/jobs/<job-id>/watch-status.json`

`output/` is ignored by git.

## Models

By default, text requests use ChatGPT's `auto` model mode:

```bash
npm run ask -- --prompt "..."
```

Use a specific model when you want a specific tradeoff:

```bash
npm run ask -- --model auto --prompt "..."
npm run ask -- --model instant --prompt "..."
npm run ask -- --model thinking --reasoning standard --prompt "..."
npm run ask -- --model thinking --reasoning extended --prompt "..."
npm run ask -- --model pro --reasoning standard --prompt "..."
npm run ask -- --model pro --reasoning extended --prompt "..."
npm run ask -- --model 5.3 --prompt "..."
npm run ask -- --model best --prompt "..."
```

| Model      | Internal value                        | Reasoning                  | Use                                                         |
| ---------- | ------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `auto`     | `auto`                                | none                       | Default ChatGPT model selection.                            |
| `instant`  | `gpt-5-5`                             | none                       | Fast GPT-5.5 responses.                                     |
| `thinking` | `gpt-5-5-thinking`                    | `standard`, `extended`     | Stronger reasoning.                                         |
| `pro`      | `gpt-5-5-pro`                         | `standard`, `extended`     | Highest reasoning, when available to the signed-in account. |
| `5.3`      | `gpt-5-3`                             | none                       | Stable legacy fallback.                                     |
| `best`     | from `.local/model-capabilities.json` | starts with `pro extended` | Best available checked model.                               |

Run `npm run model-check` after connecting, after changing ChatGPT accounts, or after upgrading/downgrading a plan. Use `npm run model-check -- --model pro` when you only want to verify GPT-5.5 Pro access.

If you explicitly request `--model pro` and the signed-in account cannot use GPT-5.5 Pro, the command fails clearly, updates `.local/model-capabilities.json`, and suggests `--model thinking --reasoning extended`. It does not silently fall back.

Use `--model best` when automatic fallback is desired. `best` starts with the cached best model and, if that model is unavailable during the request, tries the next model in this order:

1. `pro --reasoning extended`
2. `thinking --reasoning extended`
3. `thinking --reasoning standard`
4. `instant`
5. `5.3`
6. `auto`

Invalid model and reasoning combinations fail before sending. `thinking` currently exposes only `standard` and `extended`; local endpoint tests returned HTTP 422 for `light` and `heavy`.

## Commands

Default text chat and conversations:

```bash
npm run converse -- --prompt "Pick a practical topic and ask me one focused question."
```

`converse` is the response-aware path for normal text chat. It sends your message, prints ChatGPT's response, and, when run interactively, waits for the next prompt while continuing the same ChatGPT thread. End with a blank prompt, `/end`, `end`, `/done`, or `done`.

It writes a combined transcript under `output/conversations/` by default. Use `--transcript ./path/to/transcript.md` to choose a path. Use `--max-turns 5` when you want a hard stop.

List recent ChatGPT Project chats:

```bash
npm run chats
```

By default, chat listing and search stay inside the configured ChatGPT Project. To search outside that Project, ask explicitly and use `--all` or `--project <project-id>`.

Search ChatGPT chats with ChatGPT's native search:

```bash
npm run search-chats -- "observability roadmap"
npm run search-chats -- --all "observability roadmap"
```

Summarize a prior ChatGPT chat without exporting a Markdown file:

```bash
npm run chat-summary -- --search "observability roadmap"
npm run chat-summary -- --all --search "observability roadmap"
```

Use `chat-summary` for quick questions about what an old chat covered. Use `transcript` when you want a Markdown export or when Codex needs the full conversation to discuss in depth.

Resume a previous ChatGPT Project chat by recent-chat number, conversation id, local job id, or search result:

```bash
npm run resume -- 1 --prompt "Pick this back up and give me the next decision."
npm run resume -- --search "observability roadmap" --prompt "Continue this thread."
```

Export a previous ChatGPT Project chat to Markdown:

```bash
npm run transcript -- 1
npm run transcript -- --search "observability roadmap"
```

Use `--json` with `chats`, `search-chats`, `jobs`, or `transcript` when you need structured debug output.

For privacy, the default scope is the configured ChatGPT Project. Only use `--all` or another Project when the user explicitly asks to find, inspect, summarize, export, or resume a chat outside the configured Project.

## Project Instructions

Second Braincell can read and explicitly update the configured ChatGPT Project instructions. This is useful when you want the Project itself to carry persistent behavior for Codex, such as a preferred tone, response format, product-review style, or architecture-review stance.

Read the current Project instructions:

```bash
npm run project-instructions
```

Export them to a file:

```bash
npm run project-instructions -- --out ./codex-project-instructions.md
```

Preview an update without changing anything:

```bash
npm run project-instructions -- --set-file ./instructions.md
```

Apply an update:

```bash
npm run project-instructions -- --set-file ./instructions.md --yes
```

Clear Project instructions:

```bash
npm run project-instructions -- --set "" --yes
```

Instruction updates require `--yes`. Before every write, the runner saves the previous instructions under `output/project-instructions/`.

## Other Commands

One-shot or scripted text request:

```bash
npm run ask -- --prompt "Explain this in one paragraph."
```

Use `ask` when you want lower-level JSON output, scripted continuation with `--continue-job`, file attachments, image generation, Deep Research, or compatibility with the async job flow.

File or PDF question:

```bash
npm run ask -- --attach-file ./document.pdf --prompt "Answer a question about this file."
```

Image generation:

```bash
npm run ask -- --kind image --quality high --prompt "A red cube on a white table."
npm run ask -- --kind image --quality instant --prompt "A red cube on a white table."
```

Deep Research:

```bash
npm run ask -- --kind deep-research --prompt "Research this topic and produce a concise report."
```

Refresh a job:

```bash
npm run status -- <job-id>
```

List local Second Braincell jobs:

```bash
npm run chatgpt -- jobs
```

Text chat is synchronous by default. Image generation and Deep Research are async by default: they submit quickly, create a job under `output/jobs/`, start a watcher, and print the status command plus watcher status path. Agents should treat these async jobs as fire-and-forget: submit the job, create a thread heartbeat automation when available, report the job id/status path if useful, then stop or continue with other work. Creating the heartbeat is required in Codex sessions with automation support. Image jobs use a 30-second heartbeat; Deep Research jobs use a 10-minute heartbeat. Use `--sync` for image or Deep Research only when you want the initial command to wait, and only poll manually when progress or retrieval is explicitly requested.

## Privacy

Never commit or share cookies, auth headers, proof/sentinel tokens, signed URLs, HARs, cURLs, `.env`, `.local/`, or generated `output/` artifacts. The repo ignores those paths and file types by default, but git ignore rules do not protect you from manually pasting secrets into docs, issues, terminals, screenshots, or chat messages.

Before making a fork, branch, gist, issue, PR, screenshot, or support bundle public, check for:

- `.local/`
- `output/`
- `*.curl`
- `*.har`
- `.env`
- copied request headers
- `cookie:`, `authorization:`, `oai-`, `__Secure-`, `cf_`, `sentinel`, `proof`, `session`, or signed upload/download URLs

If credentials are committed, deleting the file in a later commit is not enough. Remove the public copy, rotate or invalidate the affected session, and rewrite the exposed git history before making the repository public again.

Before publishing, run your own tracked-file scan and review the files manually. Do not rely on `.gitignore` alone.

## Responsible Use

Second Braincell is an unofficial local tool. It is not an OpenAI product, SDK, or documented API client. It uses browser-observed ChatGPT web endpoints with auth headers from your own signed-in ChatGPT session.

Access is still controlled by your ChatGPT account, the ChatGPT product, and whatever limits, features, and policies apply to that account. OpenAI can change or block these endpoints at any time. Use this only for your own local workflows, and do not use it to evade rate limits, feature gates, account restrictions, safety systems, or terms that apply to ChatGPT or OpenAI services.

## Contributions

Second Braincell was built in a day to solve a real Codex workflow, so expect rough edges. It is a pragmatic local runner around browser-observed ChatGPT web API calls.

Issues, fixes, better connection instructions, new request builders, and reliability improvements are welcome. Please keep contributions careful about privacy: no committed cookies, auth headers, cURLs, HARs, signed URLs, `.local/`, or generated `output/` files.

## Development

```bash
npm test
```
