export function redactSearchIndexText(text: string): string {
  // collapse shell continuations before matching assignments so their values stay together
  text = text.replace(/\\\n/g, "");
  const lines = text.split("\n");
  let blockIndent: number | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (blockIndent !== undefined) {
      if (!line.trim() || indent > blockIndent) {
        lines[index] = "";
        continue;
      }
      blockIndent = undefined;
    }
    const field = line.match(
      /^(\s*(?:-\s*)?)(client-key-data|client-certificate-data|token|password|passwd|secret|api[_-]?key|value)\s*:\s*(.*)$/i,
    );
    if (!field) continue;
    lines[index] = `${field[1]}${field[2]}: [REDACTED]`;
    if (!field[3].trim() || /^[|>]/.test(field[3])) blockIndent = indent;
  }
  return lines
    .join("\n")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED]")
    .replace(/^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("(?:\\[\s\S]|[^"\\])*(?:"|$)|'[^']*(?:'|$)|[^\n]*)/g, "$1=[REDACTED]")
    .replace(
      /(["'](?:password|passwd|token|secret|api[_-]?key|authorization)["']\s*:\s*)("(?:\\[\s\S]|[^"\\])*(?:"|$)|'[^']*(?:'|$))/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /(--(?:password|passwd|token|secret|api[_-]?key)(?:\s+|=))(?:("[^"\n]*"|'[^'\n]*')|[^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [REDACTED]")
    .replace(/\b((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)[^\n]+/gi, "$1[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      "[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
