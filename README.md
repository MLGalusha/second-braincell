# ChatGPT Project Runner

Local Node.js runner for sending work to a ChatGPT Project from an already-authenticated browser session. It uses browser-observed ChatGPT web API endpoints directly and does not use Playwright or Chrome UI automation.

Setup needs two things:

- one ChatGPT Project URL
- one authenticated `chatgpt.com` cURL copied from DevTools

The cURL supplies auth headers only. Request bodies for messages, images, Deep Research, and file attachments are built by source code in this repo.

## Setup

1. In ChatGPT, create a Project named `Codex`.
2. In the Project settings, use project-only memory.
3. Open the Project in your browser and copy its URL.
4. Open DevTools Network, send any message in the Project, right-click the `chatgpt.com` request to `/backend-api/f/conversation`, and copy as cURL.
5. Run setup:

```bash
npm run setup
```

Setup writes ignored local files:

- `.local/config.json`: project URL and local runner config
- `.local/auth.json`: auth headers extracted from the copied cURL

For non-interactive setup:

```bash
pbpaste | npm run setup -- --project-url "https://chatgpt.com/g/g-p-.../project"
```

Check readiness:

```bash
npm run capabilities
```

## Commands

```bash
npm run ask -- --prompt "Explain this in one paragraph."
npm run ask -- --attach-file ./document.pdf --prompt "Answer a question about this file."
npm run ask -- --kind image --quality high --prompt "A red cube on a white table."
npm run ask -- --kind image --quality instant --prompt "A red cube on a white table."
npm run ask -- --kind deep-research --prompt "Research this topic and produce a concise report."
npm run status -- <job-id>
```

`ask` is async by default. It submits quickly, creates a job under `output/jobs/`, starts a watcher, and prints the status command plus watcher status path. Use `--sync` only when you want the initial command to wait.

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

## Files

Attach files with `--attach-file`:

```bash
npm run ask -- --attach-file ./spec.pdf --prompt "Summarize the requirements."
npm run ask -- --attach-file ./a.pdf --attach-file ./b.xlsx --prompt "Compare these files."
```

The runner creates the upload, PUTs bytes to the signed upload URL, processes the file, and attaches the resulting file id to the message. Signed URLs and file ids are not printed in normal output.

## Debugging

Normal usage does not require `/tmp/chatgpt-send*.curl`. The `--curl` flag and analyzer scripts remain for endpoint debugging only:

```bash
npm run analyze-send-curl -- /path/to/request.curl
npm run analyze-har -- /path/to/chatgpt.com.har
```

## Privacy

Never commit or share cookies, auth headers, proof/sentinel tokens, signed URLs, HARs, cURLs, `.env`, `.local/`, or generated `output/` artifacts. The repo ignores those paths and file types by default.

## Development

```bash
npm test
```
