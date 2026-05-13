# Public Readiness Plan

Temporary planning document. Delete or replace with public-facing docs once these requirements are implemented and verified.

## Goal

Make this repository safe and easy for other Codex users to clone, set up, and use with their own ChatGPT account. Setup should require one ChatGPT project URL and one authenticated cURL capture, not separate cURLs for text, images, Deep Research, or file upload.

## Requirements

1. One-time setup is simple:
   - User is logged into ChatGPT in their browser.
   - User creates or chooses a ChatGPT Project.
   - User pastes the project URL.
   - User copies one authenticated ChatGPT cURL from DevTools.

2. No secrets in git:
   - Never commit cookies, auth headers, signed URLs, file IDs, HARs, cURLs, `.env`, or generated outputs.
   - Store user-specific state only in ignored `.local/` and generated outputs only in ignored `output/`.

3. Recommended ChatGPT setup:
   - Create a project named `Codex`.
   - Set memory to project-only.
   - Use that project URL as the runner workspace.

4. Code-owned request builders:
   - Build bodies in source for normal message, model presets, image high, image instant, Deep Research, and file/PDF attachments.
   - Captured cURL supplies auth/headers only.

5. Agent-friendly CLI:
   - `npm run setup`
   - `npm run capabilities`
   - `npm run ask -- --prompt "..."`
   - `npm run ask -- --attach-file ./file.pdf --prompt "..."`
   - `npm run ask -- --kind image --quality high --prompt "..."`
   - `npm run ask -- --kind deep-research --prompt "..."`
   - `npm run status -- <job-id>`

6. Async by default:
   - Every job submits quickly and returns job id, status command, expected artifact path, and watcher status path.
   - Blocking behavior requires `--sync`.

7. Deterministic watcher:
   - Polls quietly while waiting.
   - Writes `watch-status.json`.
   - Writes final artifacts.
   - Exits `0` completed, `1` failed, `2` waiting, `3` timeout.

8. Capabilities reflect actual setup:
   - Report whether local auth exists.
   - Report whether project URL exists.
   - Report readiness for message, image, Deep Research, and attachments.
   - Include setup hints for missing pieces.

9. Good error messages:
   - Missing setup tells the user exactly to run `npm run setup`.
   - Invalid cURL tells the user exactly what request to copy.
   - Invalid model/reasoning combinations fail before sending.

10. Public Codex skill included:
    - Add `skills/chatgpt-direct-api/SKILL.md`.
    - Instruct agents to use `setup`, `ask`, `status`, and `capabilities`.
    - Instruct agents to avoid Playwright/UI automation.
    - Instruct agents to keep `.local/` private.

11. Concise public README:
    - Explain what this is.
    - Explain why one cURL is needed.
    - Explain recommended project setup.
    - Show setup and core commands.
    - Cover model presets, file upload, image generation, Deep Research, privacy, and troubleshooting.

12. Fresh clone test:
    - Clone into a temp directory.
    - Remove `/tmp/chatgpt-send*.curl` dependency.
    - Run `npm run setup`.
    - Verify text, file attachment, image instant, and Deep Research from only `.local/auth.json` and `.local/config.json`.

## Implementation Plan

1. Add local config layer:
   - `.local/auth.json`
   - `.local/config.json`
   - `src/local-config.js`
   - Validate missing setup cleanly.

2. Add setup wizard:
   - `npm run setup`
   - Ask for project URL.
   - Accept one copied authenticated cURL from clipboard/stdin.
   - Validate URL/method/headers.
   - Extract auth headers and safe defaults.
   - Write ignored local files.

3. Add request builders:
   - `src/request-builders.js`
   - Build message, image high, image instant, Deep Research, and attachment message bodies.

4. Refactor sending:
   - Stop depending on `/tmp/chatgpt-send*.curl` for normal operation.
   - Use local auth headers plus code-owned body builders.
   - Keep cURL-template debug paths only for endpoint debugging.

5. Refactor upload:
   - Use local auth headers for file create/process/send.
   - No upload cURLs.

6. Update capabilities:
   - Inspect `.local/` files.
   - Return readiness and setup hints.

7. Add public skill:
   - `skills/chatgpt-direct-api/SKILL.md`
   - Repo-relative instructions for Codex agents.

8. Rewrite README:
   - Public-user-oriented.
   - Concise, clear, and safe.

9. Fresh clone verification:
   - Test in a separate temp clone.
   - Prove one-cURL setup works.

10. Security audit and publish:
   - `npm test`
   - `git grep` for secrets/personal data.
   - Verify `.local/`, `output/`, `*.curl`, `*.har`, `.env` are ignored.
   - Commit and push.
