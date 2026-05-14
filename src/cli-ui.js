export function color(code, value) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return value;
  return `\x1b[${code}m${value}\x1b[0m`;
}
