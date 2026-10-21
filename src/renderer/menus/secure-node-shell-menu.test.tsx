// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecureNodeShellMenu } from "./secure-node-shell-menu";

const mocks = vi.hoisted(() => ({
  preferences: { command: "ssh", preferIPv6: false, useColimaSSH: true },
  contextName: "remote",
  createTerminalTab: vi.fn(() => ({ id: "shell-tab" })),
  sendCommand: vi.fn(async () => {}),
  hideDetails: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../common/store/node-shell-preferences-store", () => ({
  NodeShellPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));

vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ spec: { kubeconfigContext: mocks.contextName } }) } },
    Component: {
      MenuItem: ({ children, onClick, disabled }: any) => (
        <button type="button" onClick={onClick} disabled={disabled}>
          {children}
        </button>
      ),
      Icon: () => null,
      Notifications: { error: mocks.error },
      createTerminalTab: mocks.createTerminalTab,
      terminalStore: { sendCommand: mocks.sendCommand },
    },
    Navigation: { hideDetails: mocks.hideDetails },
  },
}));

function renderMenu(addresses: { type: string; address: string }[], name = "worker-1") {
  return render(
    <SecureNodeShellMenu
      object={
        { getName: () => name, metadata: { labels: { "kubernetes.io/hostname": name } }, status: { addresses } } as any
      }
      toolbar={false}
    />,
  );
}

describe("SecureNodeShellMenu", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preferences.command = "ssh";
    mocks.preferences.preferIPv6 = false;
    mocks.preferences.useColimaSSH = true;
    mocks.contextName = "remote";
    mocks.sendCommand.mockResolvedValue();
  });

  it("opens a local terminal and sends the configured command with the selected IPv6 address", async () => {
    mocks.preferences.command = "custom-connect -l admin";
    mocks.preferences.preferIPv6 = true;
    renderMenu([
      { type: "InternalIP", address: "10.0.0.1" },
      { type: "InternalIP", address: "2001:db8::1" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Secure Node Shell" }));
    await waitFor(() => expect(mocks.hideDetails).toHaveBeenCalledOnce());
    expect(mocks.createTerminalTab).toHaveBeenCalledWith({ title: "Secure Node Shell: worker-1" });
    expect(mocks.sendCommand).toHaveBeenCalledWith("custom-connect -l admin '2001:db8::1'", {
      enter: true,
      tabId: "shell-tab",
    });
  });

  it("disables connecting when the node has no valid IP", () => {
    renderMenu([{ type: "Hostname", address: "worker-1" }]);
    const button = screen.getByRole("button", { name: "Secure Node Shell" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.createTerminalTab).not.toHaveBeenCalled();
  });

  it("opens Colima without an IP and ignores the configured command", async () => {
    mocks.contextName = "colima";
    mocks.preferences.command = "custom-connect";
    mocks.preferences.preferIPv6 = true;
    renderMenu([], "colima");
    fireEvent.click(screen.getByRole("button", { name: "Secure Node Shell" }));
    await waitFor(() => expect(mocks.hideDetails).toHaveBeenCalledOnce());
    expect(mocks.sendCommand).toHaveBeenCalledWith("colima ssh", { enter: true, tabId: "shell-tab" });
  });

  it("uses regular SSH for Colima when the setting is disabled", async () => {
    mocks.contextName = "colima";
    mocks.preferences.useColimaSSH = false;
    renderMenu([{ type: "InternalIP", address: "10.0.0.1" }], "colima");
    fireEvent.click(screen.getByRole("button", { name: "Secure Node Shell" }));
    await waitFor(() => expect(mocks.hideDetails).toHaveBeenCalledOnce());
    expect(mocks.sendCommand).toHaveBeenCalledWith("ssh '10.0.0.1'", { enter: true, tabId: "shell-tab" });
  });

  it("requires an IP for Colima when the setting is disabled", () => {
    mocks.contextName = "colima";
    mocks.preferences.useColimaSSH = false;
    renderMenu([], "colima");
    expect((screen.getByRole("button", { name: "Secure Node Shell" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports terminal errors without hiding the details", async () => {
    mocks.sendCommand.mockRejectedValueOnce(new Error("terminal unavailable"));
    renderMenu([{ type: "InternalIP", address: "10.0.0.1" }]);
    fireEvent.click(screen.getByRole("button", { name: "Secure Node Shell" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Unable to open Secure Node Shell"));
    expect(mocks.hideDetails).not.toHaveBeenCalled();
  });
});
