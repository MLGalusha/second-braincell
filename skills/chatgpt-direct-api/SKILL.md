# Second Braincell

Use this skill when working in this repository to send prompts, files, images, or Deep Research tasks through Second Braincell.

## Rules

- Use the direct API CLI. Do not use Playwright, Chrome UI automation, or browser clicking for normal ChatGPT requests.
- Keep `.local/` private. It contains auth headers and must not be printed, committed, copied into docs, or included in outputs.
- Keep generated artifacts in ignored `output/`.
- Do not print cookies, auth headers, proof tokens, signed upload URLs, HARs, cURLs, file ids, or account identifiers.

## Setup

Check setup first:

```bash
npm run capabilities
```

If setup is missing, ask the user to run:

```bash
npm run setup
```

Setup is clipboard-based. Tell the user to create a new ChatGPT Project named `Codex`, click the settings button before creating it, and set Project memory to project-only because this cannot be changed after creation. Then they should copy the Project URL and press Enter. For the cURL, tell them to right-click the ChatGPT page, click Inspect, open DevTools Network, clear the network log button in the top-left of Network (`⊘`), click the Network filter box directly below it, paste `/backend-api/f/conversation`, send a short Project message, right-click the `conversation` request with the orange square `<>` icon, choose Copy > Copy as cURL, and press Enter in setup. There is no need to paste into the terminal; setup reads from the clipboard and ignores typed or pasted prompt input. The runner stores extracted headers in `.local/auth.json` and the project URL in `.local/config.json`.

## Commands

Send a text prompt:

```bash
npm run ask -- --prompt "..."
```

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

Default agent behavior for image generation and Deep Research is fire-and-forget: run the submit command, create a thread heartbeat automation when available, confirm the job was submitted, then end the response or move to the user's next task. Creating the heartbeat is required in Codex sessions with automation support. Use a 30-second heartbeat for image jobs and a 10-minute heartbeat for Deep Research jobs. Do not use the Deep Research 10-minute heartbeat schedule for image jobs. The submit command starts the background watcher.

Do not run `status`, `watch-api-job`, sleep loops, polling loops, or wait for the artifact unless the user explicitly asks to wait, check progress, retrieve the result, debug the watcher, or use `--sync`.

Use the printed status command or `npm run watch-api-job -- <job-id> --once` only when a manual check is explicitly requested.
