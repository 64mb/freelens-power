export function isIP(value: string): 0 | 4 | 6 {
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255) ? 4 : 0;
  }
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+(?:%[a-zA-Z0-9_.-]+)?$/.test(value)) return 0;
  try {
    new URL(`http://[${value.split("%")[0]}]/`);
    return 6;
  } catch {
    return 0;
  }
}
