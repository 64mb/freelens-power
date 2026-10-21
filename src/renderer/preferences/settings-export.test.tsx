// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("@freelensapp/extensions", () => ({ Renderer: { Component: { Icon: () => <span /> } } }));

import { SETTINGS_EXPORT, SETTINGS_IMPORT } from "../../common/settings-export";
import { SettingsExport } from "./settings-export";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("opens the native save flow with no renderer settings payload and shows success", async () => {
  mocks.invoke.mockResolvedValue("saved");
  render(<SettingsExport />);
  fireEvent.click(screen.getByRole("button", { name: "Export dashboard and shortcuts" }));
  expect(mocks.invoke).toHaveBeenCalledWith(SETTINGS_EXPORT);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("exported"));
});
it("silently handles cancellation and shows a generic failure", async () => {
  mocks.invoke.mockResolvedValueOnce("canceled").mockRejectedValueOnce(new Error("details"));
  render(<SettingsExport />);
  const button = screen.getByRole("button", { name: "Export dashboard and shortcuts" });
  fireEvent.click(button);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole("status").textContent).toBe("");
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Could not export settings."));
});

it("places both tooltip actions on the native heading and cleans up the portal", async () => {
  const { unmount } = render(
    <section>
      <h2>Freelens Power preferences</h2>
      <div>
        <section className="small">
          <div className="freelens-power-preferences">
            <SettingsExport />
          </div>
        </section>
      </div>
    </section>,
  );
  const heading = screen.getByRole("heading");
  const restore = screen.getByRole("button", { name: "Restore dashboard and shortcuts" });
  expect(heading.contains(restore)).toBe(true);
  expect(restore.title).toBe("Restore dashboard and shortcuts");
  expect(screen.getByRole("button", { name: "Export dashboard and shortcuts" }).title).toContain("Export");
  mocks.invoke.mockResolvedValue("restored");
  fireEvent.click(restore);
  expect(mocks.invoke).toHaveBeenCalledWith(SETTINGS_IMPORT);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("restored"));
  unmount();
  expect(document.querySelector(".power-preferences-header-actions")).toBe(null);
});

it("does not overlap import and export dialogs", async () => {
  let finish!: (result: string) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<SettingsExport />);
  const restore = screen.getByRole("button", { name: "Restore dashboard and shortcuts" });
  const save = screen.getByRole("button", { name: "Export dashboard and shortcuts" });
  fireEvent.click(restore);
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(save);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  finish("canceled");
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole("status").textContent).toBe("");
});
