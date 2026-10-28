export const EXTENSION_UPDATES_CHANNEL = "freelens-power:extension-updates";

export interface ExtensionUpdatesRequest {
  operation: "check" | "status";
}

export interface ExtensionUpdatesStatus {
  runtimeVersion: string;
  installedVersion: string;
  latestVersion?: string;
}

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function isValidVersion(value: unknown, stable = false): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  const match = semver.exec(value);
  return !!match && (!stable || !match[4]);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  if (!isValidVersion(candidate) || !isValidVersion(current)) return false;
  const left = semver.exec(candidate)!;
  const right = semver.exec(current)!;
  for (let index = 1; index <= 3; index++) {
    if (BigInt(left[index]) !== BigInt(right[index])) return BigInt(left[index]) > BigInt(right[index]);
  }
  if (!left[4] || !right[4]) return !!right[4] && !left[4];
  const a = left[4].split(".");
  const b = right[4].split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] === b[index]) continue;
    if (a[index] === undefined || b[index] === undefined) return a[index] !== undefined;
    const numericA = /^\d+$/.test(a[index]);
    const numericB = /^\d+$/.test(b[index]);
    if (numericA && numericB) return BigInt(a[index]) > BigInt(b[index]);
    if (numericA !== numericB) return !numericA;
    return a[index] > b[index];
  }
  return false;
}
