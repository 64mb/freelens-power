import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const namespace = "power-test";
export const secretSentinel = "synthetic-sensitive-value-do-not-index";
const metadata = (name: string) => ({ name, namespace, labels: { "power.test/fixture": "true" } });
const kubectl = process.env.E2E_KUBECTL || "kubectl";

export async function applyFixtures() {
  if (!process.env.KUBECONFIG) throw new Error("KUBECONFIG must point to an isolated kind cluster");
  const context = execFileSync(kubectl, ["config", "current-context"], { encoding: "utf8" }).trim();
  if (context !== "kind-power-e2e") throw new Error("Refusing fixtures outside kind-power-e2e");
  const server = execFileSync(kubectl, ["config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"], {
    encoding: "utf8",
  }).trim();
  if (
    new URL(server).protocol !== "https:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(server).hostname)
  ) {
    throw new Error("Fixture cluster must use a local kind API endpoint");
  }
  const lock = JSON.parse(await readFile("e2e/runtime-lock.json", "utf8"));
  const response = await fetch(lock.gateway.url);
  if (!response.ok) throw new Error(`Gateway CRD fixture download failed: ${response.status}`);
  const crds = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(crds).digest("hex") !== lock.gateway.sha256)
    throw new Error("Gateway CRD fixture checksum mismatch");
  execFileSync(kubectl, ["apply", "--server-side", "-f", "-"], { input: crds, stdio: "pipe" });
  execFileSync(
    kubectl,
    [
      "wait",
      "--for=condition=Established",
      "crd/gateways.gateway.networking.k8s.io",
      "crd/httproutes.gateway.networking.k8s.io",
      "--timeout=60s",
    ],
    { stdio: "pipe" },
  );
  const apply = (items: unknown[]) =>
    execFileSync(kubectl, ["apply", "-f", "-"], {
      input: JSON.stringify({ apiVersion: "v1", kind: "List", items }),
      stdio: ["pipe", "ignore", "pipe"],
    });
  apply([
    { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } },
    ...["Widget", "ClusterWidget"].map((kind) => ({
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: { name: `${kind.toLowerCase()}s.power.test` },
      spec: {
        group: "power.test",
        scope: kind === "Widget" ? "Namespaced" : "Cluster",
        names: { plural: `${kind.toLowerCase()}s`, singular: kind.toLowerCase(), kind },
        versions: [
          {
            name: "v1",
            served: true,
            storage: true,
            schema: {
              openAPIV3Schema: {
                type: "object",
                properties: { spec: { type: "object", properties: { description: { type: "string" } } } },
              },
            },
          },
        ],
      },
    })),
  ]);
  execFileSync(kubectl, [
    "wait",
    "--for=condition=Established",
    "crd/widgets.power.test",
    "crd/clusterwidgets.power.test",
    "--timeout=60s",
  ]);
  apply([
    { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: "team+ops" }, rules: [] },
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "GatewayClass",
      metadata: { name: "sample-gateway-class" },
      spec: { controllerName: "power.test/synthetic-controller" },
    },
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "Gateway",
      metadata: metadata("sample-gateway"),
      spec: { gatewayClassName: "sample-gateway-class", listeners: [{ name: "http", protocol: "HTTP", port: 80 }] },
    },
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: metadata("sample-route"),
      spec: {
        parentRefs: [{ name: "sample-gateway", sectionName: "http" }],
        rules: [{ backendRefs: [{ name: "sample-service", port: 80, weight: 100 }] }],
      },
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { ...metadata("k8s-lockbox-secret"), annotations: { "power.test/private": secretSentinel } },
      stringData: { value: secretSentinel },
    },
    ...Array.from({ length: process.env.E2E_LANE === "extended" ? 1200 : 520 }, (_, i) => ({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: metadata(`inventory-${String(i).padStart(4, "0")}`),
      data: { value: secretSentinel },
    })),
    {
      apiVersion: "power.test/v1",
      kind: "Widget",
      metadata: metadata("sample-widget"),
      spec: { description: "neutral fixture" },
    },
    { apiVersion: "power.test/v1", kind: "ClusterWidget", metadata: { name: "sample-cluster-widget" } },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: metadata("sample-service"),
      spec: { selector: { app: "ready-sample" }, ports: [{ port: 80, targetPort: 8080 }] },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: metadata("ready-workload"),
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "ready-sample" } },
        template: {
          metadata: { labels: { app: "ready-sample" } },
          spec: { containers: [{ name: "sample", image: "registry.k8s.io/pause:3.10" }] },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: metadata("unready-workload"),
      spec: {
        containers: [
          {
            name: "sample",
            image: "registry.k8s.io/pause:3.10",
            readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 1 },
          },
        ],
      },
    },
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { ...metadata("pending-workload"), labels: { app: "sample" } },
      spec: {
        nodeSelector: { "power.test/nonexistent-node": "true" },
        containers: [{ name: "sample", image: "registry.k8s.io/pause:3.10" }],
      },
    },
  ]);
  // these statuses are synthetic API evidence without a running gateway controller
  const conditions = ["Accepted", "ResolvedRefs"].map((type) => ({
    type,
    status: "True",
    reason: type,
    observedGeneration: 1,
    lastTransitionTime: "2026-01-01T00:00:00Z",
    message: "Synthetic test evidence",
  }));
  execFileSync(
    kubectl,
    [
      "patch",
      "httproute",
      "sample-route",
      "-n",
      namespace,
      "--subresource=status",
      "--type=merge",
      "-p",
      JSON.stringify({
        status: {
          parents: [
            {
              parentRef: { name: "sample-gateway", sectionName: "http" },
              controllerName: "power.test/synthetic-controller",
              conditions,
            },
          ],
        },
      }),
    ],
    { stdio: "pipe" },
  );
  execFileSync(kubectl, ["rollout", "status", "deployment/ready-workload", "-n", namespace, "--timeout=120s"], {
    stdio: "pipe",
  });
}

export function mutateConfigMap(action: "create" | "delete") {
  const args =
    action === "create"
      ? ["create", "configmap", "churn-marker", "--from-literal=fixture=neutral", "-n", namespace]
      : ["delete", "configmap", "churn-marker", "-n", namespace];
  execFileSync(kubectl, args, { stdio: "pipe" });
}
