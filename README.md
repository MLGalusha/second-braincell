# ChatGPT Project Runner

Local Node.js runner for using browser-observed ChatGPT web UI API endpoints from an already-authenticated account. It exposes a small agent-facing CLI for text, image generation, and Deep Research jobs without normal UI automation.

This project does not store credentials. It expects request templates copied from the user's logged-in browser DevTools into local `/tmp/chatgpt-*.curl` files.

## Quick Start

```bash
npm run capabilities
npm run ask -- --prompt "Explain this in one paragraph."
npm run ask -- --kind image --quality high --prompt "A red cube on a white table."
npm run ask -- --kind deep-research --prompt "Research this topic and produce a concise report."
npm run status -- <job-id>
```

`ask` is async by default. It submits the request, creates a job under `output/jobs/`, and starts a deterministic watcher.

## Output

- Text and Deep Research: `output/jobs/<job-id>/response.md`
- Image generation: `output/images/<job-id>.png`
- Job metadata: `output/jobs/<job-id>/job.json`
- Watcher status: `output/jobs/<job-id>/watch-status.json`

`output/` is generated runtime data and is ignored by git.

## Model Presets

Use presets instead of raw ChatGPT model slugs:

```bash
npm run ask -- --model gpt-5.3 --prompt "..."
npm run ask -- --model gpt-5.5-thinking --reasoning standard --prompt "..."
npm run ask -- --model gpt-5.5-thinking --reasoning heavy --prompt "..."
npm run ask -- --model gpt-5.5-thinking --reasoning extended --prompt "..."
npm run ask -- --model gpt-5.5-pro --reasoning extended --prompt "..."
```

Invalid combinations fail before sending. For example, `gpt-5.3 --reasoning extended` is rejected.

## Image Generation

High-quality image generation is the default:

```bash
npm run ask -- --kind image --quality high --prompt "..."
```

Use instant for faster drafts:

```bash
npm run ask -- --kind image --quality instant --prompt "..."
```

The runner polls conversation history for `image_asset_pointer`, resolves `/backend-api/files/:file_id/download`, and saves the image locally.

## Deep Research

Deep Research uses the captured `/backend-api/f/conversation` request template and is async by default:

```bash
npm run ask -- --kind deep-research --prompt "..."
```

Completion is detected from conversation history. The final report is extracted from the Deep Research widget state at:

```text
message.metadata.chatgpt_sdk.widget_state.report_message.content.parts[0]
```

## Request Templates

Expected local templates:

- `/tmp/chatgpt-send.curl`
- `/tmp/chatgpt-send-image.curl`
- `/tmp/chatgpt-send-image-instant.curl`
- `/tmp/chatgpt-send-deep-research.curl`

These files are intentionally outside the repo because they contain sensitive browser request headers.

## Debugging Tools

Analyze captured request shape without printing secrets:

```bash
npm run analyze-send-curl -- /tmp/chatgpt-send.curl
npm run analyze-upload-curls
npm run analyze-har -- /path/to/chatgpt.com.har
```

Verify read endpoints from a copied Cookie header or cURL on stdin:

```bash
CHATGPT_PROJECT_URL="https://chatgpt.com/g/<project>/project" pbpaste | npm run verify-api
```

Set `CHATGPT_PROJECT_URL` when using project-list verification without relying on a captured project URL.

Replay a captured send request for smoke testing:

```bash
npm run verify-send-replay
```

## Privacy Rules

Do not commit, print, or share:

- cookies
- authorization headers
- CSRF/sentinel/proof tokens
- signed URLs
- account IDs
- private file IDs
- raw HAR/cURL files containing credentials

The analyzers redact endpoint reports and schema shapes, but raw captures should remain local only.

## Development

```bash
npm test
```

The active code path is direct API based. Legacy Chrome/Playwright UI automation was removed from this repo.
