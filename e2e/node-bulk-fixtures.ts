import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface SyntheticNode {
  metadata: { name: string; uid: string; labels?: Record<string, string> };
  spec: { unschedulable?: boolean };
}

export function createNodeBulkFixtures() {
  if (!process.env.CI || process.platform !== "linux" || !process.env.KUBECONFIG || !process.env.E2E_KUBECTL)
    throw new Error("Node mutation fixtures require the isolated Linux CI runtime");
  const binary = process.env.E2E_KUBECTL;
  const kubeconfig = process.env.KUBECONFIG;
  const context = "kind-power-e2e";
  const run = (args: string[], input?: string) =>
    execFileSync(binary, ["--kubeconfig", kubeconfig, ...args], {
      encoding: "utf8",
      input,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  const endpoint = () => {
    if (run(["config", "current-context"]).trim() !== context)
      throw new Error("Refusing node fixtures outside kind-power-e2e");
    const server = run(["config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"]).trim();
    const url = new URL(server);
    if (url.protocol !== "https:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Node fixture cluster must use the isolated loopback API endpoint");
    return server;
  };
  const server = endpoint();
  const command = (args: string[], input?: string) => {
    if (endpoint() !== server) throw new Error("Node fixture cluster endpoint changed");
    return run(["--context", context, "--request-timeout=20s", ...args], input);
  };
  const prefix = `power-bulk-${randomUUID().slice(0, 8)}`;
  const nodes: SyntheticNode[] = [];
  const read = (target: SyntheticNode) => {
    const node = JSON.parse(command(["get", "node", target.metadata.name, "-o", "json"])) as SyntheticNode;
    if (node.metadata.uid !== target.metadata.uid || node.metadata.labels?.["power.test/node-bulk"] !== prefix)
      throw new Error("Synthetic node identity changed");
    return node;
  };
  const assertEmpty = () => {
    for (const target of nodes) {
      read(target);
      const pods = JSON.parse(
        command([
          "get",
          "pods",
          "--all-namespaces",
          "--field-selector",
          `spec.nodeName=${target.metadata.name}`,
          "-o",
          "json",
        ]),
      );
      if (!Array.isArray(pods.items) || pods.items.length !== 0)
        throw new Error("Refusing to drain a fixture node containing pods");
    }
  };
  const cleanup = () => {
    for (const target of nodes) {
      read(target);
      command(
        ["delete", "--raw", `/api/v1/nodes/${target.metadata.name}`, "-f", "-"],
        JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: target.metadata.uid } }),
      );
    }
  };
  try {
    for (const suffix of ["a", "b"]) {
      const name = `${prefix}-${suffix}`;
      const node = JSON.parse(
        command(
          ["create", "-f", "-", "-o", "json"],
          JSON.stringify({
            apiVersion: "v1",
            kind: "Node",
            metadata: { name, labels: { "power.test/node-bulk": prefix } },
            spec: { taints: [{ key: "power.test/synthetic", value: "true", effect: "NoSchedule" }] },
          }),
        ),
      ) as SyntheticNode;
      nodes.push(node);
      command([
        "patch",
        "node",
        name,
        "--subresource=status",
        "--type=merge",
        "-p",
        JSON.stringify({
          status: {
            conditions: [
              {
                type: "Ready",
                status: "False",
                reason: "SyntheticFixture",
                message: "No kubelet runs on this synthetic node",
                lastTransitionTime: "2026-01-01T00:00:00Z",
              },
            ],
          },
        }),
      ]);
    }
    assertEmpty();
    return { prefix, nodes, read, assertEmpty, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
