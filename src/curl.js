export function normalizeCurl(value) {
  return String(value || "")
    .replace(/\\\r?\n/g, " ")
    .replace(/\^\r?\n/g, " ")
    .replace(/`\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shellUnquote(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) return text.slice(1, -1);
  return text;
}

export function parseCurl(source, { dropUnsafeHeaders = true } = {}) {
  const normalized = normalizeCurl(source);
  const urlMatch = normalized.match(/curl\s+(?:--location\s+)?(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const headers = {};
  const headerRe = /(?:-H|--header)\s+(?:"([^"]*)"|'([^']*)'|([^\s][^\s]*))/g;
  for (const match of normalized.matchAll(headerRe)) {
    const header = match[1] || match[2] || match[3] || "";
    const split = header.indexOf(":");
    if (split === -1) continue;
    const name = header.slice(0, split).trim().toLowerCase();
    if (dropUnsafeHeaders && ["host", "content-length"].includes(name)) continue;
    headers[name] = header.slice(split + 1).trim();
  }

  const dataMatch =
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+\$?'((?:\\'|[^'])*)'/) ||
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+"((?:\\"|[^"])*)"/) ||
    normalized.match(/(?:--data-raw|--data-binary|--data|--data-ascii)\s+(@[^\s]+)/);
  const methodMatch = normalized.match(/(?:-X|--request)\s+(?:"([^"]+)"|'([^']+)'|([A-Z]+))/i);
  const bodyRaw = dataMatch ? (dataMatch[1] || "").replace(/\\'/g, "'").replace(/\\"/g, '"') : "";
  const method = (methodMatch?.[1] || methodMatch?.[2] || methodMatch?.[3] || (bodyRaw ? "POST" : "GET")).toUpperCase();

  return {
    method,
    url: shellUnquote(urlMatch?.[1] || urlMatch?.[2] || urlMatch?.[3] || ""),
    headers,
    bodyRaw,
    hasData: Boolean(dataMatch),
    dataIsFileReference: bodyRaw.startsWith("@"),
  };
}
