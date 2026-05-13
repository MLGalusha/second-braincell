# ChatGPT Project Runner

Local Node.js runner for sending work to a ChatGPT Project from an already-authenticated browser session. It uses browser-observed ChatGPT web API endpoints directly and does not use Playwright or Chrome UI automation.

Setup needs two things:

- one ChatGPT Project URL
- one authenticated `chatgpt.com` cURL copied from DevTools

The cURL supplies auth headers only. Request bodies for messages, images, Deep Research, and file attachments are built by source code in this repo.

## Setup

Run setup:

```bash
npm run setup
```

The interactive setup is clipboard-based. You copy each item, then press Enter in the terminal. Do not paste the copied value into the terminal.

### Step 1: Create The ChatGPT Project

1. Open ChatGPT in your browser.
2. Start creating a new Project.
3. Name the Project `Codex`.
4. Before creating it, click the settings button.
5. Set Project memory to project-only. This cannot be changed after the Project is created.
6. Create and open the `Codex` Project.

### Step 2: Copy The Project URL

1. Click the browser address bar while the `Codex` Project is open.
2. Copy the URL.
3. Go back to the terminal.
4. Press Enter when setup asks for the Project URL.

Do not paste the URL. The setup command reads it from your clipboard.

### Step 3: Copy One Authenticated cURL

1. Keep the same `Codex` Project open in ChatGPT.
2. Right-click the ChatGPT page and click Inspect.
3. In DevTools, click the Network tab.
4. Click the clear network log button in the top-left of Network. It looks like a circle with a line through it.
5. Click the Network filter box and paste this exact filter:

```text
/backend-api/f/conversation
```

6. Send a short message in the Project, such as `setup test`.
7. A request named `conversation` should appear in the Network table.
8. Right-click the `conversation` request.
9. Choose Copy > Copy as cURL.
10. Go back to the terminal.
11. Press Enter when setup asks for the authenticated cURL.

Do not paste the cURL. DevTools cURLs are often multiline and can break terminal input. The setup command reads the copied cURL from your clipboard.

Setup writes ignored local files:

- `.local/config.json`: project URL and local runner config
- `.local/auth.json`: auth headers extracted from the copied cURL

For non-interactive setup or systems without `pbpaste`, save the cURL to a local ignored file and pass it explicitly:

```bash
npm run setup -- --project-url "https://chatgpt.com/g/g-p-.../project" --curl-file ./request.curl
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
