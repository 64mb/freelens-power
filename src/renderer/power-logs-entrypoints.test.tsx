// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openPowerLogs, PowerLogsMenu, startPowerLogsEntrypoints } from "./power-logs-entrypoints";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  hideDetails: vi.fn(),
  logs: {} as any,
  power: {} as any,
  pods: [] as any[],
  replicaSets: [] as any[],
  jobs: [] as any[],
}));
vi.mock("../common/store/logs-preferences-store", () => ({
  LogsPreferencesStore: { getInstanceOrCreate: () => mocks.logs },
}));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => mocks.power },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: "cluster-a" } }) } },
    Navigation: { navigate: mocks.navigate, hideDetails: mocks.hideDetails },
    K8sApi: {
      replicaSetStore: {
        get items() {
          return mocks.replicaSets;
        },
      },
      jobStore: {
        get items() {
          return mocks.jobs;
        },
      },
      podsStore: {
        get items() {
          return mocks.pods;
        },
      },
    },
    Component: {
      MenuItem: ({ children, onClick }: any) => (
        <div className="MenuItem" onClick={onClick}>
          {children}
        </div>
      ),
      Icon: () => <i className="Icon">subject</i>,
      SubMenu: ({ children }: any) => <div className="SubMenu">{children}</div>,
      StatusBrick: ({ className, title }: any) => <i className={`StatusBrick ${className}`} title={title} />,
    },
  },
}));
const target = { kind: "Pod" as const, name: "example", namespace: "default", uid: "pod-uid" };
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.logs = observable({ enabled: true });
  mocks.power = observable({ enabled: true });
  mocks.replicaSets = [];
  mocks.jobs = [];
  mocks.pods = [
    {
      metadata: { uid: target.uid },
      getName: () => target.name,
      getNs: () => target.namespace,
      getAllContainers: () => [{}],
    },
  ];
  vi.stubGlobal("location", window.location);
  vi.spyOn(window, "location", "get").mockReturnValue({
    protocol: "https:",
    hostname: "cluster-a.renderer.freelens.app",
    pathname: "/pods",
  } as Location);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("replaces only the native sibling and restores inline display on disable and disposal", async () => {
  const view = render(
    <div>
      <div className="MenuItem" style={{ display: "flex" }}>
        <i className="Icon">subject</i>
        <span className="title">Logs</span>
      </div>
      <PowerLogsMenu
        object={{ kind: target.kind, metadata: target, getAllContainersWithType: () => [] } as any}
        toolbar
      />
    </div>,
  );
  const native = view.container.querySelector<HTMLElement>(".MenuItem")!;
  stop = startPowerLogsEntrypoints();
  expect(native.style.display).toBe("none");
  act(() =>
    runInAction(() => {
      mocks.logs.enabled = false;
    }),
  );
  expect(native.style.display).toBe("flex");
  act(() =>
    runInAction(() => {
      mocks.logs.enabled = true;
    }),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(native.style.display).toBe("none");
  stop();
  expect(native.style.display).toBe("flex");
});
it("intercepts only the native pod logs cell with an unambiguous store identity", () => {
  document.body.innerHTML =
    '<div class="TableRow"><div class="TableCell name">example</div><div class="TableCell namespace">default</div><div class="TableCell logs"><i class="Icon">subject</i></div></div>';
  stop = startPowerLogsEntrypoints();
  const icon = document.querySelector("i")!;
  fireEvent.click(icon);
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(JSON.parse(new URLSearchParams(mocks.navigate.mock.calls[0][0].split("?")[1]).get("target")!)).toEqual(target);
  mocks.pods.push(mocks.pods[0]);
  fireEvent.click(icon);
  expect(mocks.navigate).toHaveBeenCalledOnce();
  runInAction(() => {
    mocks.power.enabled = false;
  });
  mocks.pods.pop();
  fireEvent.click(icon);
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
it("preserves menu fallback without an identified replacement and rejects invalid targets", () => {
  document.body.innerHTML = '<div class="MenuItem"><i class="Icon">subject</i><span class="title">Logs</span></div>';
  stop = startPowerLogsEntrypoints();
  expect(document.querySelector<HTMLElement>(".MenuItem")!.style.display).toBe("");
  openPowerLogs({ ...target, uid: "" });
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("opens the selected container without bubbling into the all-container action", () => {
  const view = render(
    <PowerLogsMenu
      object={
        {
          kind: "Pod",
          metadata: target,
          getAllContainersWithType: () => [{ name: "application" }, { name: "sidecar" }],
        } as any
      }
      toolbar={false}
    />,
  );
  const listener = vi.fn();
  window.addEventListener("power-logs-target", listener);
  fireEvent.click(view.getByText("sidecar"));
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(new URLSearchParams(mocks.navigate.mock.calls[0][0].split("?")[1]).get("container")).toBe("sidecar");
  expect(listener.mock.calls[0][0].detail).toEqual({ ...target, container: "sidecar" });
  fireEvent.click(view.getByText("All containers"));
  expect(new URLSearchParams(mocks.navigate.mock.calls[1][0].split("?")[1]).has("container")).toBe(false);
  openPowerLogs(target, "../invalid");
  expect(mocks.navigate).toHaveBeenCalledTimes(2);
  window.removeEventListener("power-logs-target", listener);
});

it("keeps native container status markers in the logs hover submenu", () => {
  const view = render(
    <PowerLogsMenu
      object={
        {
          kind: "Pod",
          metadata: target,
          getAllContainersWithType: () => [{ name: "ready" }, { name: "starting" }, { name: "failed" }],
          getContainerStatuses: () => [
            { name: "ready", ready: true, restartCount: 0, state: { running: {} } },
            { name: "starting", ready: false, state: { waiting: {} } },
            { name: "failed", ready: false, state: { terminated: {} } },
          ],
        } as any
      }
      toolbar
    />,
  );
  expect(view.getByText("ready").previousElementSibling?.className).toBe("StatusBrick running");
  expect(view.getByText("starting").previousElementSibling?.className).toBe("StatusBrick waiting");
  expect(view.getByText("failed").previousElementSibling?.className).toBe("StatusBrick terminated");
});

it.each([
  "Deployment",
  "DaemonSet",
  "StatefulSet",
  "ReplicaSet",
  "Job",
  "CronJob",
])("opens %s logs directly without a pod submenu", (kind) => {
  const workload = { kind, metadata: { name: "sample", namespace: "default", uid: "workload-uid" } };
  const view = render(<PowerLogsMenu object={workload as any} toolbar />);
  expect(view.container.querySelector(".SubMenu")).toBeNull();
  fireEvent.click(view.getByText("Logs"));
  expect(JSON.parse(new URLSearchParams(mocks.navigate.mock.calls[0][0].split("?")[1]).get("target")!)).toEqual({
    kind,
    name: "sample",
    namespace: "default",
    uid: "workload-uid",
  });
});
