# Second Braincell

Give your Codex agent a second braincell: a direct path into your own ChatGPT Project for work ChatGPT is already good at.

Second Braincell lets Codex hand off tasks to ChatGPT for:

- Deep Research reports
- image generation
- file and PDF question-answering with ChatGPT's stronger upload/RAG system
- normal ChatGPT model responses from a Project you control

This is useful because Codex can call this local runner instead of trying to recreate those workflows itself. For large PDFs and file-heavy questions, ChatGPT's uploaded-file retrieval is often a better fit than iterative search from Codex. ChatGPT image generation and Deep Research also run through your ChatGPT account, not your Codex rate limit.

Second Braincell uses browser-observed ChatGPT web API endpoints from your already-authenticated browser session. It does not use Playwright or Chrome UI automation.

## How It Works

Second Braincell is a local Node.js CLI that your Codex agent can call with `npm run ask`.

Setup captures two local-only pieces of information:

- your ChatGPT Project URL
- auth headers extracted from one authenticated `chatgpt.com` cURL copied from DevTools

Those are stored in ignored files:

- `.local/config.json`
- `.local/auth.json`

The copied cURL is not used as a request template. It only provides auth headers. The source code in this repo builds the actual request bodies for messages, images, Deep Research, and file attachments.

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
npm run setup
```

`npm run setup` is interactive and clipboard-based. It walks you through:

- creating a ChatGPT Project named `Codex`
- setting Project memory to project-only before the Project is created
- copying the Project URL
- copying one authenticated `/backend-api/f/conversation` cURL from DevTools

No need to paste copied values into the terminal. Setup reads from your clipboard after you press Enter, and anything typed or pasted at the setup prompts is ignored.

Check readiness:

```bash
npm run capabilities
```

## Use It From Codex

After setup is complete, go to your Codex agent and tell it:

```text
Read and follow skills/chatgpt-direct-api/SKILL.md.
Use Second Braincell to ask ChatGPT: Reply with exactly: agent works
```

If your agent supports installing repo skills, install the skill from `skills/chatgpt-direct-api/SKILL.md`. Otherwise, telling the agent to read that file is enough.

## Commands

Text:

```bash
npm run ask -- --prompt "Explain this in one paragraph."
```

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

Text chat is synchronous by default. Image generation and Deep Research are async by default: they submit quickly, create a job under `output/jobs/`, start a watcher, and print the status command plus watcher status path. Agents should treat these async jobs as fire-and-forget: submit the job, create a thread heartbeat automation when available, report the job id/status path if useful, then stop or continue with other work. Creating the heartbeat is required in Codex sessions with automation support. Image jobs use a 30-second heartbeat; Deep Research jobs use a 5-minute heartbeat. Use `--sync` for image or Deep Research only when you want the initial command to wait, and only poll manually when progress or retrieval is explicitly requested.

## Output

- Text and Deep Research: `output/jobs/<job-id>/response.md`
- Images: `output/images/<job-id>.png`
- Job metadata: `output/jobs/<job-id>/job.json`
- Watcher status: `output/jobs/<job-id>/watch-status.json`

`output/` is ignored by git.

## Models

Use model presets:

```bash
npm run ask -- --model gpt-5.3 --prompt "..."
npm run ask -- --model gpt-5.5-thinking --reasoning standard --prompt "..."
npm run ask -- --model gpt-5.5-thinking --reasoning heavy --prompt "..."
npm run ask -- --model gpt-5.5-pro --reasoning extended --prompt "..."
```

Invalid model and reasoning combinations fail before sending.

## Privacy

Never commit or share cookies, auth headers, proof/sentinel tokens, signed URLs, HARs, cURLs, `.env`, `.local/`, or generated `output/` artifacts. The repo ignores those paths and file types by default.

## Contributions

Second Braincell was built in a day to solve a real Codex workflow, so expect rough edges. It is not a polished SDK or official API client; it is a pragmatic local runner around browser-observed ChatGPT web API calls.

Issues, fixes, better setup instructions, new request builders, and reliability improvements are welcome. Please keep contributions careful about privacy: no committed cookies, auth headers, cURLs, HARs, signed URLs, `.local/`, or generated `output/` files.

## Development

```bash
npm test
```
