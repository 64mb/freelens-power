import { execFileSync } from "node:child_process";

export const logsNamespace = "power-logs-test";
export const logsDeployment = "power-logs-application";
export const logsDaemonSet = "power-logs-agent";
export const logsSecretSentinel = "synthetic-power-logs-credential";
const image =
  "docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";

export function applyPowerLogsFixtures() {
  if (!process.env.KUBECONFIG) throw new Error("KUBECONFIG must point to an isolated kind cluster");
  const kubectl = process.env.E2E_KUBECTL || "kubectl";
  const context = execFileSync(kubectl, ["config", "current-context"], { encoding: "utf8" }).trim();
  if (context !== "kind-power-e2e") throw new Error("Refusing log fixtures outside kind-power-e2e");
  const server = new URL(
    execFileSync(kubectl, ["config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"], {
      encoding: "utf8",
    }).trim(),
  );
  if (server.protocol !== "https:" || !["127.0.0.1", "localhost", "[::1]"].includes(server.hostname))
    throw new Error("Log fixture cluster must use a local kind API endpoint");
  const container = (name: string) => ({
    name,
    image,
    imagePullPolicy: "IfNotPresent",
    command: [
      "sh",
      "-c",
      `i=0; while true; do printf '{"level":"info","message":"fixture ready","sequence":%s,"source":"${name}"}\\n' "$i"; printf '{"level":"error","message":"fixture failure","credentials":{"token":"${logsSecretSentinel}"},"sequence":%s}\\n' "$i"; printf 'WARN fixture warning sequence=%s\\n' "$i"; i=$((i+1)); sleep 2; done`,
    ],
    resources: { requests: { cpu: "5m", memory: "8Mi" }, limits: { cpu: "50m", memory: "32Mi" } },
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 1000,
      capabilities: { drop: ["ALL"] },
    },
  });
  const workload = (kind: "Deployment" | "DaemonSet", name: string, names: string[]) => ({
    apiVersion: "apps/v1",
    kind,
    metadata: { name, namespace: logsNamespace },
    spec: {
      ...(kind === "Deployment" ? { replicas: 3 } : {}),
      selector: { matchLabels: { "power.test/logs": name } },
      template: {
        metadata: { labels: { "power.test/logs": name } },
        spec: { terminationGracePeriodSeconds: 1, containers: names.map(container) },
      },
    },
  });
  execFileSync(kubectl, ["apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        { apiVersion: "v1", kind: "Namespace", metadata: { name: logsNamespace } },
        workload("Deployment", logsDeployment, ["application", "sidecar"]),
        workload("DaemonSet", logsDaemonSet, ["agent"]),
      ],
    }),
    stdio: ["pipe", "ignore", "pipe"],
  });
  for (const resource of [`deployment/${logsDeployment}`, `daemonset/${logsDaemonSet}`]) {
    execFileSync(kubectl, ["rollout", "status", resource, "-n", logsNamespace, "--timeout=120s"], {
      stdio: "pipe",
      timeout: 125000,
    });
  }
  const pod = execFileSync(
    kubectl,
    [
      "get",
      "pods",
      "-n",
      logsNamespace,
      "-l",
      `power.test/logs=${logsDeployment}`,
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!pod.startsWith(`${logsDeployment}-`)) throw new Error("Log fixture pod was not found");
  return pod;
}
