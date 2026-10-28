// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
  preferences: undefined as any,
}));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Notifications: { info: mocks.info, error: mocks.error },
      Icon: () => null,
      Button: (props: any) => (
        <button disabled={props.disabled} onClick={props.onClick}>
          {props.children}
        </button>
      ),
    },
  },
}));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("./extension-update", () => ({
  EXTENSION_UPDATE_STARTED: "test-update-started",
  requestExtensionUpdate: mocks.request,
}));

import { startExtensionUpdateNotifications } from "./extension-update-notifications";

let stop: (() => void) | undefined;
const removed: ReturnType<typeof vi.fn>[] = [];
const status = (installedVersion = "2.8.2", latestVersion?: string, runtimeVersion = "2.8.2") => ({
  runtimeVersion,
  installedVersion,
  latestVersion,
});
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const advance = async (time: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(time);
  });
};
const begin = async () => {
  stop = startExtensionUpdateNotifications();
  await flush();
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
  removed.length = 0;
  mocks.preferences = observable({ checkUpdates: true });
  mocks.invoke.mockResolvedValue(status());
  mocks.info.mockImplementation(() => {
    const remove = vi.fn();
    removed.push(remove);
    return remove;
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("delays network checks and announces a numerically newer stable version only once", async () => {
  mocks.invoke.mockImplementation(async (_channel, request) =>
    status("2.9.0", request.operation === "check" ? "2.10.0" : undefined, "2.9.0"),
  );
  await begin();
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("freelens-power:extension-updates", { operation: "status" });
  await advance(4999);
  expect(mocks.info).not.toHaveBeenCalled();
  await advance(1);
  render(mocks.info.mock.calls[0][0]);
  expect(screen.getByText("Freelens Power 2.10.0 is available")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(removed[0]).toHaveBeenCalledOnce();
  await advance(15 * 60 * 1000);
  expect(mocks.info).toHaveBeenCalledOnce();
});
it.each([
  "2.8.2",
  "2.8.1",
  "2.9.0-beta.1",
  "invalid",
])("does not announce an unavailable stable update %s", async (latest) => {
  mocks.invoke.mockResolvedValue(status("2.8.2", latest));
  await begin();
  await advance(5000);
  expect(mocks.info).not.toHaveBeenCalled();
});
it("disables checks and removes notices while discarding an in-flight result", async () => {
  mocks.invoke.mockResolvedValue(status("2.8.2", "2.9.0"));
  await begin();
  expect(mocks.info).toHaveBeenCalledOnce();
  runInAction(() => {
    mocks.preferences.checkUpdates = false;
  });
  expect(removed[0]).toHaveBeenCalledOnce();
  await advance(20 * 60 * 1000);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  runInAction(() => {
    mocks.preferences.checkUpdates = true;
  });
  await advance(5000);
  runInAction(() => {
    mocks.preferences.checkUpdates = false;
  });
  resolve(status("2.8.2", "2.10.0"));
  await flush();
  expect(mocks.info).toHaveBeenCalledOnce();
});
it("retains an attempted update across teardown and recommends restart after installation", async () => {
  await begin();
  document.dispatchEvent(new Event("test-update-started"));
  expect(sessionStorage.getItem("freelens-power-update-attempt")).toBeTruthy();
  await advance(15_000);
  expect(mocks.info).not.toHaveBeenCalled();
  stop?.();
  expect(sessionStorage.getItem("freelens-power-update-attempt")).toBeTruthy();
  mocks.invoke.mockResolvedValue(status("2.9.0", undefined, "2.9.0"));
  await begin();
  render(mocks.info.mock.calls[0][0]);
  expect(screen.getByText("Freelens Power 2.9.0 is installed")).toBeTruthy();
  expect(sessionStorage.getItem("freelens-power-update-attempt")).toBeNull();
});
it("recommends restart when installed code is newer than the running version without an attempt", async () => {
  mocks.invoke.mockResolvedValue(status("2.9.0"));
  await begin();
  expect(mocks.info.mock.calls[0][1].id).toBe("freelens-power-restart-recommended");
  stop?.();
  expect(removed[0]).toHaveBeenCalledOnce();
});
it("does not recommend restart after canceled or failed attempts and clears expired tracking", async () => {
  await begin();
  document.dispatchEvent(new Event("test-update-started"));
  mocks.invoke.mockRejectedValueOnce(new Error("installer failed"));
  await advance(30 * 60 * 1000);
  expect(mocks.info).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("freelens-power-update-attempt")).toBeNull();
});
it("cleans up timers, listeners and notices and ignores results after disposal", async () => {
  mocks.invoke.mockResolvedValue(status("2.8.2", "2.9.0"));
  await begin();
  stop?.();
  expect(removed[0]).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  document.dispatchEvent(new Event("test-update-started"));
  expect(sessionStorage.getItem("freelens-power-update-attempt")).toBeNull();
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await begin();
  stop?.();
  resolve(status("2.8.2", "2.10.0"));
  await flush();
  expect(mocks.info).toHaveBeenCalledOnce();
});
it("does not run in cluster frames", async () => {
  vi.stubGlobal("process", { ...process, isMainFrame: false });
  await begin();
  await advance(20 * 60 * 1000);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("restarts only after an explicit click with the installed version and disables repeated pending requests", async () => {
  mocks.invoke.mockResolvedValue(status("2.9.0"));
  await begin();
  render(mocks.info.mock.calls[0][0]);
  const button = screen.getByRole("button", { name: "Restart Freelens" }) as HTMLButtonElement;
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("freelens-power:extension-updates", { operation: "status" });
  let resolve!: (value: boolean) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(button);
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(mocks.invoke).toHaveBeenLastCalledWith("freelens-power:extension-updates", {
    operation: "restart",
    version: "2.9.0",
  });
  resolve(true);
  await flush();
  expect(button.disabled).toBe(true);
  expect(mocks.error).not.toHaveBeenCalled();
});
it.each(["rejected", "declined"])("reports a %s restart request and permits retry", async (failure) => {
  mocks.invoke.mockResolvedValue(status("2.9.0"));
  await begin();
  render(mocks.info.mock.calls[0][0]);
  const button = screen.getByRole("button", { name: "Restart Freelens" }) as HTMLButtonElement;
  if (failure === "rejected") mocks.invoke.mockRejectedValueOnce(new Error("restart unavailable"));
  else mocks.invoke.mockResolvedValueOnce(false);
  fireEvent.click(button);
  await flush();
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    "Could not restart Freelens. Close and reopen it when convenient.",
  );
  expect(button.disabled).toBe(false);
  mocks.invoke.mockResolvedValueOnce(true);
  fireEvent.click(button);
  await flush();
  expect(mocks.invoke).toHaveBeenCalledTimes(3);
  expect(mocks.error).toHaveBeenCalledOnce();
});
it("keeps a disposed restart notice inert and suppresses errors from an earlier pending request", async () => {
  mocks.invoke.mockResolvedValue(status("2.9.0"));
  await begin();
  render(mocks.info.mock.calls[0][0]);
  const button = screen.getByRole("button", { name: "Restart Freelens" });
  let reject!: (error: Error) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  fireEvent.click(button);
  stop?.();
  reject(new Error("disposed"));
  await flush();
  expect(mocks.error).not.toHaveBeenCalled();
  cleanup();
  render(mocks.info.mock.calls[0][0]);
  fireEvent.click(screen.getByRole("button", { name: "Restart Freelens" }));
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});
