// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CLUSTER_ICONS_CHANNEL } from "../common/cluster-icon-ipc";
import { clusterIconDataUrl, defaultClusterIconDesign } from "../common/cluster-icons";
import { ClusterIconsPage } from "./cluster-icons";

import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("@freelensapp/extensions", () => ({
  Common: { Store: { ExtensionStore: class {} } },
  Renderer: {
    Catalog: { catalogEntities: { getById: () => ({ metadata: { source: "example" } }) } },
    Component: {
      Avatar: ({ title, src, background }: { title: string; src?: string; background?: string }) => (
        <div data-testid="native-avatar" data-background={background}>
          {src ? <img src={src} alt={title} /> : title}
        </div>
      ),
      Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Icon: () => <span />,
      Input: ({ onChange, ...props }: { onChange: (value: string) => void }) => (
        <input {...props} onChange={(event) => onChange(event.target.value)} />
      ),
      Button: ({
        label,
        children,
        primary: _primary,
        plain: _plain,
        ...props
      }: {
        label?: string;
        children?: ReactNode;
        primary?: boolean;
        plain?: boolean;
      }) => (
        <button {...props}>
          {label}
          {children}
        </button>
      ),
    },
  },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const original = [
  { id: "cluster-a", name: "North Studio", customized: false },
  { id: "cluster-b", name: "Local Lab", customized: false },
];

it("edits a selected cluster with generated initials, applies exact identity and remembers only the current design", async () => {
  mocks.invoke.mockResolvedValueOnce(original);
  render(<ClusterIconsPage />);
  await screen.findByRole("button", { name: /North Studio/ });
  fireEvent.change(screen.getByLabelText("Find a cluster"), { target: { value: "North" } });
  expect(screen.queryByRole("button", { name: /Local Lab/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /North Studio/ }));
  expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("NS");
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "ABC" } });
  fireEvent.click(screen.getByRole("button", { name: "Database" }));
  fireEvent.click(screen.getByRole("button", { name: "Outline" }));
  fireEvent.click(screen.getByRole("button", { name: "Material Indigo #3f51b5" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  const design = {
    ...defaultClusterIconDesign("North Studio"),
    label: "ABC",
    glyph: "database",
    outlineColor: "#3f51b5",
  };
  const saved = [{ ...original[0], customized: true, design, icon: clusterIconDataUrl(design) }, original[1]];
  mocks.invoke.mockResolvedValueOnce(saved);
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.invoke).toHaveBeenLastCalledWith(CLUSTER_ICONS_CHANNEL, { operation: "apply", id: "cluster-a", design });
  fireEvent.click(screen.getByRole("button", { name: /North Studio/ }));
  expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("ABC");
  expect(screen.queryByRole("button", { name: /Restore original/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
});

it("keeps invalid label input recoverable and cancel never applies changes", async () => {
  mocks.invoke.mockResolvedValue(original);
  render(<ClusterIconsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /North Studio/ }));
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "👩‍💻" } });
  expect(screen.getByRole("alert").textContent).toContain("three visible characters");
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Label"), { target: { value: "OK" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("uses native current icons for original color and default clusters", async () => {
  mocks.invoke.mockResolvedValue([{ ...original[0], icon: "#123456" }, original[1]]);
  render(<ClusterIconsPage />);
  await screen.findByRole("button", { name: /North Studio/ });
  const avatars = screen.getAllByTestId("native-avatar");
  expect(avatars[0].getAttribute("data-background")).toBe("#123456");
  expect(avatars[0].querySelector("img")).toBeNull();
  expect(avatars[1].getAttribute("data-background")).toBeNull();
  expect(avatars[1].querySelector("img")).toBeNull();
});

it("dismisses a color palette before closing the icon editor with Escape", async () => {
  mocks.invoke.mockResolvedValue(original);
  render(<ClusterIconsPage />);
  fireEvent.click(await screen.findByRole("button", { name: /North Studio/ }));
  fireEvent.click(screen.getByRole("button", { name: "Icon color" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("group", { name: "Icon color palette" })).toBeNull();
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
