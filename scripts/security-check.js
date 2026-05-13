import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter((file) => file && file !== "scripts/security-check.js");

const checks = [
  { name: "cookie header", re: /\bcookie:\s*[^`\s][^\n]{20,}/i },
  { name: "authorization header", re: /\bauthorization:\s*(bearer\s+)?[^`\s][^\n]{20,}/i },
  { name: "ChatGPT secure cookie", re: /__Secure-[A-Za-z0-9_.-]+=[^;\s]{10,}/ },
  { name: "Cloudflare cookie", re: /\bcf_[A-Za-z0-9_.-]+=[^;\s]{10,}/i },
  { name: "OpenAI token-like value", re: /\boai-[A-Za-z0-9_-]{20,}/ },
  { name: "signed URL", re: /X-Amz-Signature=|GoogleAccessId=|Signature=/i },
  { name: "raw copied cURL", re: /curl\s+['"]?https:\/\/chatgpt\.com\/backend-api\/.*(?:-H|--header)/i },
];

const findings = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const check of checks) {
      if (check.re.test(line)) findings.push(`${file}:${index + 1}: possible ${check.name}`);
    }
  });
}

if (findings.length) {
  console.error("Potential secrets found in tracked files:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("No tracked ChatGPT auth secrets found.");
