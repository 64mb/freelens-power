import { describe, expect, it, vi } from "vitest";
import { discoverAiResources, sanitizeAiDiscovery } from "./ai-discovery";

describe("AI API discovery", () => {
  it("returns only validated readable descriptors and rejects subresources", () => {
    expect(
      sanitizeAiDiscovery(
        {
          resources: [
            {
              name: "examples",
              kind: "Example",
              namespaced: true,
              verbs: ["get", "list", "create"],
              extra: "example-sensitive",
            },
            { name: "pods/exec", kind: "Pod", namespaced: true, verbs: ["get"] },
            { name: "pod/proxy", kind: "Pod", namespaced: true, verbs: ["get"] },
            { name: "writeonly", kind: "Example", namespaced: true, verbs: ["create"] },
          ],
        },
        "example.com/v1",
      ),
    ).toEqual([
      { apiVersion: "example.com/v1", resource: "examples", kind: "Example", namespaced: true, verbs: ["get", "list"] },
    ]);
  });

  it("generates bounded GET paths locally and never follows returned URLs", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api") return { versions: ["v1", "../secrets"] };
      if (path === "/apis")
        return {
          groups: [
            { name: "example.com", versions: [{ version: "v1", groupVersion: "https://example.com" }] },
            { name: "../secrets", versions: [{ version: "v1" }] },
          ],
        };
      return { resources: [{ name: "examples", kind: "Example", namespaced: true, verbs: ["list"] }] };
    });
    const result = await discoverAiResources(get);
    expect(get.mock.calls.map(([path]) => path).sort()).toEqual(
      ["/api", "/apis", "/api/v1", "/apis/example.com/v1"].sort(),
    );
    expect(result).toHaveLength(2);
    expect(result[1].apiVersion).toBe("example.com/v1");
  });
});
