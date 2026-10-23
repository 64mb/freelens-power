import { describe, expect, it } from "vitest";
import { diagnoseHpa } from "./hpa-diagnostics";

describe("HPA diagnostics", () => {
  it("treats explicit scaling disablement at zero as neutral while preserving metric failures", () => {
    const disabled = {
      spec: { maxReplicas: 5 },
      status: {
        currentReplicas: 0,
        conditions: [{ type: "ScalingActive", status: "False", reason: "ScalingDisabled" }],
      },
    };
    expect(diagnoseHpa(disabled).state).toBe("neutral");
    expect(diagnoseHpa(disabled).summary).toContain("disabled");
    expect(
      diagnoseHpa({
        ...disabled,
        status: {
          ...disabled.status,
          conditions: [{ type: "ScalingActive", status: "False", reason: "FailedGetResourceMetric" }],
        },
      }).state,
    ).toBe("warning");
  });
  it("keeps minimum and fixed replica constraints neutral", () => {
    const conditions = [{ type: "ScalingLimited", status: "True", reason: "TooFewReplicas" }];
    expect(diagnoseHpa({ spec: { minReplicas: 2, maxReplicas: 5 }, status: { conditions } }).state).toBe("neutral");
    expect(
      diagnoseHpa({
        spec: { minReplicas: 2, maxReplicas: 2 },
        status: { conditions: [{ ...conditions[0], reason: "TooManyReplicas" }] },
      }).state,
    ).toBe("neutral");
  });
  it("warns on actual maximum blocking and metric failure", () => {
    expect(
      diagnoseHpa({
        spec: { maxReplicas: 5 },
        status: { conditions: [{ type: "ScalingLimited", status: "True", reason: "TooManyReplicas" }] },
      }).state,
    ).toBe("warning");
    expect(
      diagnoseHpa({
        status: {
          conditions: [
            {
              type: "ScalingActive",
              status: "False",
              reason: "FailedGetResourceMetric",
              message: "Metrics unavailable",
            },
          ],
        },
      }).evidence[0],
    ).toContain("Metrics unavailable");
  });
  it("does not infer maximum blocking from replica count alone", () => {
    expect(diagnoseHpa({ spec: { maxReplicas: 5 }, status: { currentReplicas: 5, desiredReplicas: 5 } }).state).toBe(
      "neutral",
    );
  });
});
