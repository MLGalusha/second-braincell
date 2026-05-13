import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sendApiMessage } from "../src/chatgpt-api.js";
import { JOBS_DIR } from "../src/config.js";
import { getFlag, jobId, readTextArg } from "../src/util.js";

export async function runApiMessage(argv = process.argv) {
  const curlPath = getFlag(argv, "--curl", resolve(tmpdir(), "chatgpt-send.curl"));
  const model = getFlag(argv, "--model", undefined);
  const thinkingEffort = getFlag(argv, "--thinking-effort", undefined);
  const prompt = readTextArg(argv);
  const result = await sendApiMessage({ prompt, curlPath, model, thinkingEffort });

  const id = jobId("api-message");
  const dir = resolve(JOBS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "prompt.md"), `${prompt}\n`);
  writeFileSync(resolve(dir, "response.md"), `${result.responseText || ""}\n`);
  writeFileSync(
    resolve(dir, "job.json"),
    `${JSON.stringify(
      {
        id,
        kind: "api-message",
        status: result.ok && !result.errorSeen ? "completed" : "failed",
        statusCode: result.status,
        contentType: result.contentType,
        finishSeen: result.finishSeen,
        errorSeen: result.errorSeen,
        eventTypes: result.eventTypes,
        promptLength: prompt.length,
        responseLength: result.responseText.length,
      },
      null,
      2,
    )}\n`,
  );

  const output = { id, status: result.status, ok: result.ok, responsePath: resolve(dir, "response.md"), response: result.responseText };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runApiMessage().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
