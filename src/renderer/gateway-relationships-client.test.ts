import { expect, it, vi } from "vitest";
import { loadGatewayInventory } from "./gateway-relationships-client";

it("treats absent Gateway APIs as optional and denied discovery as unknown", async () => {
  const transport = { get: vi.fn().mockRejectedValue({ status: 404 }) };
  expect((await loadGatewayInventory(transport, new AbortController().signal)).gaps).toEqual([]);
  transport.get.mockRejectedValue({ status: 403 });
  expect((await loadGatewayInventory(transport, new AbortController().signal)).gaps.join()).toContain("unknown");
});
it("negotiates each resource served version and paginates without fetching secrets", async () => {
  const calls: string[] = [];
  const transport = {
    get: vi.fn(async (path: string, query?: Record<string, string | number>): Promise<any> => {
      calls.push(path);
      if (path === "/apis/gateway.networking.k8s.io")
        return { preferredVersion: { version: "v1" }, versions: [{ version: "v1" }, { version: "v1beta1" }] };
      if (path.endsWith("/v1"))
        return { resources: [{ kind: "Gateway", name: "gateways", namespaced: true, verbs: ["list"] }] };
      if (path.endsWith("/v1beta1"))
        return { resources: [{ kind: "ReferenceGrant", name: "referencegrants", namespaced: true, verbs: ["list"] }] };
      if (path.endsWith("/gateways"))
        return {
          items: [{ metadata: { name: query?.continue ? "second" : "first", namespace: "edge" } }],
          metadata: { continue: query?.continue ? "" : "next" },
        };
      return { items: [] };
    }),
  };
  const inventory = await loadGatewayInventory(transport, new AbortController().signal);
  expect(inventory.objects).toHaveLength(2);
  expect(inventory.objects[0].selfLink).toBe("/apis/gateway.networking.k8s.io/v1/namespaces/edge/gateways/first");
  expect(calls).toContain("/apis/gateway.networking.k8s.io/v1beta1/referencegrants");
  expect(calls.some((path) => path.includes("secrets"))).toBe(false);
});
it("falls back to accessible namespaces and the focused namespace after all-namespace denial", async () => {
  const calls: string[] = [];
  const transport = {
    get: vi.fn(async (path: string): Promise<any> => {
      calls.push(path);
      if (path === "/apis/gateway.networking.k8s.io") return { versions: [{ version: "v1alpha2" }] };
      if (path.endsWith("/v1alpha2"))
        return {
          resources: [
            { kind: "TCPRoute", name: "tcproutes", namespaced: true, verbs: ["list"] },
            { kind: "ReferenceGrant", name: "referencegrants", namespaced: true, verbs: ["list"] },
          ],
        };
      if (path === "/api/v1/namespaces") throw { status: 403 };
      if (!path.includes("/namespaces/")) throw { status: 403 };
      if (path.includes("/denied/")) throw { status: 403 };
      return { items: path.endsWith("tcproutes") ? [{ metadata: { name: "stream", namespace: "app" } }] : [] };
    }),
  };
  const inventory = await loadGatewayInventory(transport, new AbortController().signal, {
    focusedNamespace: "app",
    knownNamespaces: ["denied"],
  });
  expect(inventory.objects[0].kind).toBe("TCPRoute");
  expect(inventory.grantNamespaces).toEqual(["app"]);
  expect(inventory.gaps.join()).toContain("namespace fallback is partial");
  expect(calls).toContain("/apis/gateway.networking.k8s.io/v1alpha2/namespaces/app/tcproutes");
});
