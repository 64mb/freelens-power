import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const lock = JSON.parse(await readFile(new URL("./runtime-lock.json", import.meta.url), "utf8"));
const root = resolve(process.env.E2E_WORK_DIR || ".e2e-runtime");
const bin = join(root, "bin");
await mkdir(bin, { recursive: true });
const env = { ...process.env, KUBECONFIG: join(root, "kubeconfig"), PATH: `${bin}:${process.env.PATH}` };
const run = (command, args, options = {}) => execFileSync(command, args, { env, stdio: "inherit", ...options });
const cluster = "power-e2e";

if (process.argv.includes("--cleanup")) {
  run(join(bin, "kind"), ["delete", "cluster", "--name", cluster]);
} else {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("CI provisioning requires Linux x64; see e2e/README.md for local app testing");
  }
  for (const [name, item] of Object.entries(lock).filter(([name]) => name !== "nodes" && name !== "gateway")) {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Download ${name} failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(buffer).digest("hex") !== item.sha256) {
      throw new Error(`Checksum mismatch for ${name}`);
    }
    const filename = join(bin, name);
    await writeFile(filename, buffer);
    await chmod(filename, 0o755);
  }
  run(join(bin, "freelens"), ["--appimage-extract"], { cwd: root });
  run(join(bin, "kind"), [
    "create",
    "cluster",
    "--name",
    cluster,
    "--kubeconfig",
    env.KUBECONFIG,
    "--image",
    lock.nodes[process.env.E2E_LANE || "smoke"],
    "--wait",
    "180s",
  ]);
  if (process.env.GITHUB_ENV) {
    await writeFile(
      process.env.GITHUB_ENV,
      [
        `E2E_WORK_DIR=${root}`,
        `KUBECONFIG=${env.KUBECONFIG}`,
        `FREELENS_EXECUTABLE=${join(root, "squashfs-root", "freelens")}`,
        `E2E_KUBECTL=${join(bin, "kubectl")}`,
        "",
      ].join("\n"),
      { flag: "a" },
    );
  }
}
