import { describe, expect, it } from "vitest";
import { buildNodeShellCommand, isColimaNode, selectNodeAddress } from "./node-shell";

describe("selectNodeAddress", () => {
  const addresses = [
    { type: "ExternalIP", address: "203.0.113.5" },
    { type: "InternalIP", address: "10.0.0.5" },
    { type: "ExternalIP", address: "2001:db8::5" },
    { type: "InternalIP", address: "fd00::5" },
  ];

  it("prefers internal IPv4 by default regardless of list order", () => {
    expect(selectNodeAddress(addresses, false)).toBe("10.0.0.5");
  });

  it("prefers internal IPv6 when requested", () => {
    expect(selectNodeAddress(addresses, true)).toBe("fd00::5");
  });

  it.each([
    [true, "10.0.0.5", "2001:db8::5"],
    [false, "fd00::5", "203.0.113.5"],
  ])("prioritizes the preferred family over internal addresses (%s)", (preferIPv6, internal, external) => {
    expect(
      selectNodeAddress(
        [
          { type: "InternalIP", address: internal },
          { type: "ExternalIP", address: external },
        ],
        preferIPv6,
      ),
    ).toBe(external);
  });

  it.each([
    [true, "10.0.0.5"],
    [false, "fd00::5"],
  ])("falls back to the available family (%s)", (preferIPv6, address) => {
    expect(selectNodeAddress([{ type: "ExternalIP", address }], preferIPv6)).toBe(address);
  });

  it("skips hostnames, malformed addresses, and unrelated address types", () => {
    expect(
      selectNodeAddress(
        [
          { type: "InternalIP", address: "node.example.com" },
          { type: "InternalIP", address: "999.0.0.1" },
          { type: "Hostname", address: "10.0.0.1" },
          { type: "ExternalIP", address: "203.0.113.5" },
        ],
        false,
      ),
    ).toBe("203.0.113.5");
  });

  it("returns undefined when no supported valid address exists", () => {
    expect(selectNodeAddress([], false)).toBeUndefined();
    expect(selectNodeAddress([{ type: "InternalIP", address: "[::1]" }], true)).toBeUndefined();
  });
});

describe("buildNodeShellCommand", () => {
  it.each(["", "   "])("defaults an empty command to ssh", (command) => {
    expect(buildNodeShellCommand(command, "10.0.0.5")).toBe("ssh '10.0.0.5'");
  });

  it("preserves command arguments and quoting", () => {
    expect(buildNodeShellCommand(' ssh -p 2222 -o "StrictHostKeyChecking=no" ', "2001:db8::5")).toBe(
      "ssh -p 2222 -o \"StrictHostKeyChecking=no\" '2001:db8::5'",
    );
  });

  it.each([
    "node.example.com",
    "10.0.0.1; echo bad",
    "[::1]",
    "",
    "999.0.0.1",
  ])("rejects an invalid IP literal (%s)", (address) => {
    expect(() => buildNodeShellCommand("ssh", address)).toThrow("valid IP literal");
  });
});

describe("isColimaNode", () => {
  it("recognizes the default Colima context and node", () => {
    expect(isColimaNode("colima", "colima", "colima")).toBe(true);
  });

  it.each([
    ["remote", "colima", "colima"],
    ["my-colima-cluster", "colima", "colima"],
    ["colima-profile", "colima", "colima"],
    ["colima", "worker-1", "colima"],
    ["colima", "colima", undefined],
    [undefined, "colima", "colima"],
  ])("rejects other contexts and nodes (%s, %s, %s)", (context, name, hostname) => {
    expect(isColimaNode(context, name!, hostname)).toBe(false);
  });
});
