import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cleanupTestProxies } from "../../e2e/proxy-cleanup";

it("only terminates the exact executable and exact isolated profile owner", () => {
  const root = mkdtempSync(join(tmpdir(), "proxy-cleanup-fixture-"));
  const profile = join(tmpdir(), "freelens-power-e2e-example");
  const terminate = vi.fn();
  const entry = (pid: number, executable: string, owner: string) => {
    mkdirSync(join(root, String(pid)));
    symlinkSync(join(root, executable), join(root, String(pid), "exe"));
    writeFileSync(join(root, String(pid), "environ"), `OTHER=value\0FREELENS_INTEGRATION_TESTING_DIR=${owner}\0`);
  };
  try {
    entry(11, "freelens-k8s-proxy", profile);
    entry(12, "freelens-k8s-proxy", `${profile}-other`);
    entry(13, "node", profile);
    entry(14, "freelens-k8s-proxy", "");
    mkdirSync(join(root, "15"));
    cleanupTestProxies(profile, root, terminate);
    expect(terminate.mock.calls).toEqual([[11]]);
    terminate.mockClear();
    cleanupTestProxies("", root, terminate);
    cleanupTestProxies(join(tmpdir(), "other-profile"), root, terminate);
    expect(terminate).not.toHaveBeenCalled();
    terminate.mockImplementation(() => {
      throw new Error("Process exited");
    });
    expect(() => cleanupTestProxies(profile, root, terminate)).not.toThrow();
    expect(() => cleanupTestProxies(profile, join(root, "missing"), terminate)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
