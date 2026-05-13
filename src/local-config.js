import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT_DIR } from "./config.js";
import { readJson, writeJson } from "./util.js";

export const LOCAL_DIR = resolve(ROOT_DIR, ".local");
export const LOCAL_AUTH_PATH = resolve(LOCAL_DIR, "auth.json");
export const LOCAL_CONFIG_PATH = resolve(LOCAL_DIR, "config.json");

const REQUIRED_AUTH_HEADER_RE = /^(authorization|cookie)$/i;
const UNSAFE_HEADER_NAMES = new Set(["host", "content-length"]);

export function normalizeCurl(value) {
  return String(value || "")
    .replace(/\\\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCurl(source) {
  const normalized = normalizeCurl(source);
  const urlMatch = normalized.match(/curl\s+(?:--location\s+)?(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const headers = {};
  const headerRe = /(?:-H|--header)\s+(?:"([^"]*)"|'([^']*)'|([^\s][^\s]*))/g;
  for (const match of normalized.matchAll(headerRe)) {
    const header = match[1] || match[2] || match[3] || "";
    const split = header.indexOf(":");
    if (split === -1) continue;
    const name = header.slice(0, split).trim().toLowerCase();
    if (["host", "content-length"].includes(name)) continue;
    headers[name] = header.slice(split + 1).trim();
  }
  const dataMatch =
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+\$?'((?:\\'|[^'])*)'/) ||
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+"((?:\\"|[^"])*)"/);
  const bodyRaw = dataMatch ? dataMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"') : "";
  const methodMatch = normalized.match(/(?:-X|--request)\s+([A-Z]+)/i);
  return {
    method: methodMatch?.[1]?.toUpperCase() || (bodyRaw ? "POST" : "GET"),
    url: urlMatch?.[1] || urlMatch?.[2] || urlMatch?.[3] || "",
    headers,
    bodyRaw,
  };
}

export function projectIdFromProjectUrl(projectUrl = "") {
  return String(projectUrl).match(/\/g\/(g-p-[0-9a-f]+)(?:-|\/|$)/i)?.[1] || null;
}

export function normalizeProjectUrl(projectUrl) {
  const value = String(projectUrl || "").trim();
  if (!value) throw new Error("Project URL is required.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Project URL must be a valid ChatGPT project URL.");
  }
  if (url.hostname !== "chatgpt.com") throw new Error("Project URL must be on chatgpt.com.");
  if (!projectIdFromProjectUrl(url.toString())) throw new Error("Project URL must include a ChatGPT project id like /g/g-p-...");
  url.hash = "";
  return url.toString();
}

export function sanitizeAuthHeaders(headers = {}) {
  const safe = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (UNSAFE_HEADER_NAMES.has(name)) continue;
    if (value == null || String(value).trim() === "") continue;
    safe[name] = String(value).trim();
  }
  return safe;
}

export function validateAuthCurl(curlText) {
  const parsed = parseCurl(curlText);
  if (!parsed.url) throw new Error("Invalid cURL: could not parse a request URL.");
  let url;
  try {
    url = new URL(parsed.url);
  } catch {
    throw new Error("Invalid cURL: request URL is not valid.");
  }
  if (url.hostname !== "chatgpt.com") {
    throw new Error("Invalid cURL: copy an authenticated request to chatgpt.com from DevTools.");
  }
  const headers = sanitizeAuthHeaders(parsed.headers);
  if (!Object.keys(headers).some((name) => REQUIRED_AUTH_HEADER_RE.test(name))) {
    throw new Error("Invalid cURL: expected an authenticated ChatGPT request with an Authorization or Cookie header.");
  }
  return { ...parsed, url: url.toString(), headers };
}

export function writeLocalSetup({ projectUrl, curlText }) {
  const normalizedProjectUrl = normalizeProjectUrl(projectUrl);
  const parsed = validateAuthCurl(curlText);
  mkdirSync(LOCAL_DIR, { recursive: true, mode: 0o700 });
  const projectId = projectIdFromProjectUrl(normalizedProjectUrl);
  writeJson(LOCAL_CONFIG_PATH, {
    version: 1,
    projectUrl: normalizedProjectUrl,
    projectId,
    conversationEndpoint: "https://chatgpt.com/backend-api/f/conversation",
    createdAt: new Date().toISOString(),
  });
  writeJson(LOCAL_AUTH_PATH, {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceRequest: {
      method: parsed.method,
      origin: new URL(parsed.url).origin,
      pathname: new URL(parsed.url).pathname,
    },
    headers: parsed.headers,
  });
  return localSetupStatus();
}

export function loadLocalConfig({ required = true } = {}) {
  if (!existsSync(LOCAL_CONFIG_PATH)) {
    if (required) throw new Error("Missing local config. Run `npm run setup` and paste your ChatGPT project URL.");
    return null;
  }
  return readJson(LOCAL_CONFIG_PATH);
}

export function loadLocalAuth({ required = true } = {}) {
  if (!existsSync(LOCAL_AUTH_PATH)) {
    if (required) throw new Error("Missing local auth. Run `npm run setup` and paste one authenticated ChatGPT cURL from DevTools.");
    return null;
  }
  const auth = readJson(LOCAL_AUTH_PATH);
  return { ...auth, headers: sanitizeAuthHeaders(auth.headers || {}) };
}

export function loadLocalHeaders({ required = true } = {}) {
  const auth = loadLocalAuth({ required });
  const config = loadLocalConfig({ required });
  if (!auth || !config) return null;
  return {
    ...auth.headers,
    origin: "https://chatgpt.com",
    referer: config.projectUrl,
  };
}

export function localSetupStatus() {
  const authExists = existsSync(LOCAL_AUTH_PATH);
  const configExists = existsSync(LOCAL_CONFIG_PATH);
  let auth = null;
  let config = null;
  let authError = null;
  let configError = null;
  try {
    auth = authExists ? loadLocalAuth({ required: false }) : null;
  } catch (error) {
    authError = error.message;
  }
  try {
    config = configExists ? loadLocalConfig({ required: false }) : null;
  } catch (error) {
    configError = error.message;
  }
  const hasAuthHeader = Boolean(auth?.headers && Object.keys(auth.headers).some((name) => REQUIRED_AUTH_HEADER_RE.test(name)));
  const hasProjectUrl = Boolean(config?.projectUrl && projectIdFromProjectUrl(config.projectUrl));
  const ready = hasAuthHeader && hasProjectUrl;
  return {
    ready,
    auth: {
      exists: authExists,
      ready: hasAuthHeader,
      path: LOCAL_AUTH_PATH,
      error: authError || undefined,
    },
    config: {
      exists: configExists,
      ready: hasProjectUrl,
      path: LOCAL_CONFIG_PATH,
      projectUrl: config?.projectUrl || null,
      projectId: config?.projectId || projectIdFromProjectUrl(config?.projectUrl || "") || null,
      error: configError || undefined,
    },
    features: {
      message: ready,
      imageHigh: ready,
      imageInstant: ready,
      deepResearch: ready,
      attachments: ready,
    },
    hints: ready
      ? []
      : [
          "Run `npm run setup`.",
          "Use a ChatGPT Project URL and one authenticated chatgpt.com cURL copied from DevTools.",
        ],
  };
}

export function readCurlInputFile(path) {
  return readFileSync(resolve(path), "utf8");
}
