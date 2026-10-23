import { describe, expect, it } from "vitest";
import { diagnoseService } from "./service-diagnostics";

const service = {
  metadata: { name: "web", namespace: "sample" },
  spec: { selector: { app: "web" }, ports: [{ port: 80, targetPort: "http" }] },
};
const pod = {
  metadata: { name: "web-1", namespace: "sample", labels: { app: "web" } },
  spec: { containers: [{ ports: [{ name: "http", containerPort: 8080 }] }] },
  status: { conditions: [{ type: "Ready", status: "True" }] },
};
const slice = {
  metadata: { name: "web-a", namespace: "sample", labels: { "kubernetes.io/service-name": "web" } },
  addressType: "IPv4",
  endpoints: [{ addresses: ["192.0.2.1"], conditions: { ready: true } }],
  ports: [{ port: 8080 }],
};
describe("service diagnostics", () => {
  it("matches namespace and labels and resolves named targets", () => {
    const result = diagnoseService(
      service,
      [pod, { ...pod, metadata: { ...pod.metadata, namespace: "other" } }],
      [slice],
    );
    expect(result.matchingPods).toHaveLength(1);
    expect(result.readyEndpoints).toBe(1);
    expect(result.ports[0].unresolved).toBe(0);
    expect(result.ports[0].endpointPorts).toEqual([8080]);
  });
  it("checks numeric targets and missing dual-stack family evidence", () => {
    const result = diagnoseService(
      { ...service, spec: { ...service.spec, ipFamilies: ["IPv4", "IPv6"], ports: [{ port: 80, targetPort: 9090 }] } },
      [pod],
      [slice],
    );
    expect(result.ports[0].numericMismatch).toBe(true);
    expect(result.limitations.join(" ")).toContain("IPv6");
  });
  it("resolves restartable sidecar ports but excludes ordinary init containers", () => {
    const sidecar = {
      ...pod,
      spec: {
        containers: [],
        initContainers: [{ restartPolicy: "Always", ports: [{ name: "http", containerPort: 8080 }] }],
      },
    };
    expect(diagnoseService(service, [sidecar], [slice]).ports[0].unresolved).toBe(0);
    expect(
      diagnoseService(
        service,
        [
          {
            ...sidecar,
            spec: { ...sidecar.spec, initContainers: [{ ports: [{ name: "http", containerPort: 8080 }] }] },
          },
        ],
        [slice],
      ).ports[0].unresolved,
    ).toBe(1);
  });
  it("keeps ready endpoints with missing or wrong-protocol ports partial", () => {
    for (const ports of [[], [{ port: 8080, protocol: "UDP" }]]) {
      const result = diagnoseService(service, [pod], [{ ...slice, ports }]);
      expect(result.readyEndpoints).toBe(1);
      expect(result.missingEndpointPorts).toBe(true);
      expect(result.summary).toContain("Partial evidence");
    }
  });
  it("distinguishes unavailable evidence from empty backend lists", () => {
    expect(diagnoseService(service, undefined, []).summary).toContain("Partial evidence");
    expect(diagnoseService(service, [], []).summary).toContain("no pods");
  });
  it("reports unresolved names and excludes explicitly unready or terminating endpoints", () => {
    const result = diagnoseService(
      service,
      [{ ...pod, spec: {} }],
      [
        {
          ...slice,
          endpoints: [
            { addresses: ["192.0.2.1"], conditions: { ready: false } },
            { addresses: ["192.0.2.2"], conditions: { ready: true, terminating: true } },
          ],
        },
      ],
    );
    expect(result.ports[0].unresolved).toBe(1);
    expect(result.readyEndpoints).toBe(0);
  });
  it("keeps manual endpoints, ExternalName and dual stack explicit", () => {
    expect(diagnoseService({ ...service, spec: {} }, [], [slice]).summary).toContain("manually managed");
    expect(diagnoseService({ ...service, spec: { type: "ExternalName" } }, undefined, undefined).summary).toContain(
      "DNS",
    );
    expect(diagnoseService(service, [pod], [slice, { ...slice, addressType: "IPv6" }]).limitations.join(" ")).toContain(
      "same backend",
    );
  });
});
