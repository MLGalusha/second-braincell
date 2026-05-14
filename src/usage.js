export function usage() {
  return `
Usage:
  npm run chatgpt -- ask --prompt "..."
  npm run chatgpt -- connect
  npm run chatgpt -- ask --kind image --quality high --prompt "..."
  npm run chatgpt -- ask --kind deep-research --prompt "..."
  npm run chatgpt -- converse --prompt "Start a conversation..."
  npm run chatgpt -- chats
  npm run chatgpt -- search-chats "query"
  npm run chatgpt -- chat-summary --search "query"
  npm run chatgpt -- project-instructions
  npm run chatgpt -- resume <chat-number|conversation-id|job-id> --prompt "..."
  npm run chatgpt -- transcript <chat-number|conversation-id|job-id>
  npm run chatgpt -- status <job-id>
  npm run chatgpt -- capabilities
  npm run chatgpt -- model-check
  npm run chatgpt -- api-message --prompt "..."
  npm run chatgpt -- api-deep-research --prompt "..."
  npm run chatgpt -- api-image --async --watch --prompt "..."
  npm run chatgpt -- api-status <job-id>
  npm run chatgpt -- jobs
  npm run chatgpt -- result <job-id>

Options:
  --prompt TEXT
  --prompt-file PATH
  --async
  --curl PATH
  --curl-file PATH
  --project-url URL
  --model MODEL
  --reasoning standard|extended
  --thinking-effort VALUE
  --kind message|image|deep-research
  --quality high|instant
  --attach-file PATH (repeatable)
  --continue-job JOB_ID
  --conversation-id CONVERSATION_ID
  --parent-message-id MESSAGE_ID
  --transcript PATH
  --out PATH
  --limit N
  --all
  --project PROJECT_ID
  --search QUERY
  --set TEXT
  --set-file PATH
  --yes
  --max-turns N
  --sync
  --watch
  --notify
  --watch-interval-seconds N
  --watch-timeout-seconds N
`.trim();
}
