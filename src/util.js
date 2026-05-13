import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function nowIso() {
  return new Date().toISOString();
}

export function slugify(value, fallback = "untitled") {
  const clean = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

export function jobId(kind) {
  return `${kind}_${nowIso().replace(/[:.]/g, "-")}`;
}

export function readTextArg(argv) {
  const promptIndex = argv.indexOf("--prompt");
  if (promptIndex !== -1) {
    const value = argv[promptIndex + 1];
    if (!value) throw new Error("--prompt requires a value");
    return value;
  }

  const fileIndex = argv.indexOf("--prompt-file");
  if (fileIndex !== -1 || argv.indexOf("--file") !== -1) {
    const index = fileIndex !== -1 ? fileIndex : argv.indexOf("--file");
    const file = argv[index + 1];
    if (!file) throw new Error("--prompt-file requires a path");
    return readFileSync(resolve(file), "utf8").trim();
  }

  if (!process.stdin.isTTY) return readFileSync(0, "utf8").trim();
  throw new Error("Provide --prompt, --prompt-file, or stdin.");
}

export function getFlag(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
}

export function hasFlag(argv, name) {
  return argv.includes(name);
}

export function getFlags(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) {
      if (!argv[i + 1]) throw new Error(`${name} requires a value`);
      values.push(argv[i + 1]);
      i += 1;
    }
  }
  return values;
}

export function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function extFromMime(mime) {
  if (!mime) return ".png";
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".png";
}

export function uniquePath(dir, name, ext) {
  let path = resolve(dir, `${name}${ext}`);
  let i = 2;
  while (true) {
    try {
      readFileSync(path);
      path = resolve(dir, `${name}-${i}${ext}`);
      i += 1;
    } catch {
      return path;
    }
  }
}

export function displayPath(path) {
  return path.replace(`${process.cwd()}/`, "");
}

export function fileLabel(path) {
  return basename(path);
}

export function fileInfo(path) {
  const absolutePath = resolve(path);
  const stat = statSync(absolutePath);
  return {
    path: absolutePath,
    name: basename(absolutePath),
    size: stat.size,
    type: mimeFromPath(absolutePath),
  };
}

export function mimeFromPath(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".md") return "text/markdown";
  if (ext === ".csv") return "text/csv";
  if (ext === ".json") return "application/json";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".xls") return "application/vnd.ms-excel";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".doc") return "application/msword";
  return "application/octet-stream";
}
