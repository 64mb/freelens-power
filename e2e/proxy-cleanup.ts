import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export function cleanupTestProxies(
  profile: string,
  procRoot = "/proc",
  terminate: (pid: number) => unknown = (pid) => process.kill(pid, "SIGTERM"),
): void {
  if (!isAbsolute(profile) || dirname(profile) !== tmpdir() || !/^freelens-power-e2e-[\w-]+$/.test(basename(profile)))
    return;
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry) || Number(entry) <= 1) continue;
    try {
      const executable = basename(readlinkSync(join(procRoot, entry, "exe"))).replace(/ \(deleted\)$/, "");
      if (executable !== "freelens-k8s-proxy") continue;
      const environment = readFileSync(join(procRoot, entry, "environ"), "utf8").split("\0");
      if (environment.includes(`FREELENS_INTEGRATION_TESTING_DIR=${profile}`)) terminate(Number(entry));
    } catch {
      // an exited process or an unreadable environment cannot establish ownership
    }
  }
}
