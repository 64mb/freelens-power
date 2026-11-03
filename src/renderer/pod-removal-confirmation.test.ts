// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { startPodRemovalConfirmation } from "./pod-removal-confirmation";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
});

function mount(
  message = "Remove <b>24</b> items <b>pod-a, pod-b, pod-c, pod-d, pod-e</b>, and <b>19</b> more?",
  root = "Pods",
) {
  document.body.innerHTML = `<div class="${root}"><div class="AddRemoveButtons"><button class="Button remove-button"><span>remove</span></button></div></div>`;
  const remove = document.querySelector<HTMLButtonElement>(".remove-button")!;
  const confirm = vi.fn();
  const cancel = vi.fn();
  remove.onclick = () => {
    const dialog = document.createElement("div");
    dialog.className = "ConfirmDialog modal";
    dialog.dataset.testid = "confirmation-dialog";
    dialog.innerHTML = `<div class="box"><div class="confirm-content"><i class="Icon">warning</i><p>${message}</p></div><div class="confirm-buttons"><button class="Button cancel">Cancel</button><button class="Button ok primary" data-testid="confirm">Remove</button></div></div>`;
    dialog.querySelector(".ok")!.addEventListener("click", confirm);
    dialog.querySelector(".cancel")!.addEventListener("click", cancel);
    document.body.append(dialog);
  };
  return { remove, confirm, cancel };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it("lists only native preview names, highlights the remaining number and preserves removal and cancellation", async () => {
  const fixture = mount();
  stop = startPodRemovalConfirmation();
  fixture.remove.querySelector("span")!.click();
  await flush();
  const dialog = document.querySelector(".ConfirmDialog")!;
  expect([...dialog.querySelectorAll(".power-pod-removal-summary li")].map((item) => item.textContent)).toEqual([
    "pod-a",
    "pod-b",
    "pod-c",
    "pod-d",
    "pod-e",
  ]);
  expect(dialog.querySelector(".power-pod-removal-summary > p")?.textContent).toBe("Remove 24 pods?");
  expect(dialog.querySelector(".power-pod-removal-remaining")?.textContent).toBe("19");
  expect(dialog.querySelector(".power-pod-removal-remaining")?.parentElement?.textContent).toBe("and 19 more");
  expect(dialog.querySelector(".ok .Icon")?.getAttribute("aria-hidden")).toBe("true");
  expect(dialog.querySelector(".ok .icon")?.textContent).toBe("delete");
  expect(fixture.confirm).not.toHaveBeenCalled();
  (dialog.querySelector(".cancel") as HTMLButtonElement).click();
  expect(fixture.cancel).toHaveBeenCalledOnce();
  (dialog.querySelector(".ok") as HTMLButtonElement).click();
  expect(fixture.confirm).toHaveBeenCalledOnce();
  const original = dialog.querySelector(".power-pod-removal-original")!;
  stop();
  stop = undefined;
  expect(original.classList.contains("power-pod-removal-original")).toBe(false);
  expect(dialog.querySelector(".power-pod-removal-summary")).toBeNull();
  expect(dialog.querySelector(".ok")?.textContent).toBe("Remove");
  expect(dialog.classList.contains("power-pod-removal")).toBe(false);
  expect(document.querySelector('[data-freelens-power="pod-removal-confirmation"]')).toBeNull();
});

it.each([
  ["Remove item <b>pod-a</b>?", "Remove 1 pod?", 1],
  ["Remove <b>2</b> items <b>pod-a, pod-b</b>?", "Remove 2 pods?", 2],
])("handles native singular and small selections without a remaining label", async (message, heading, count) => {
  const fixture = mount(message as string);
  stop = startPodRemovalConfirmation();
  fixture.remove.click();
  await flush();
  expect(document.querySelector(".power-pod-removal-summary > p")?.textContent).toBe(heading);
  expect(document.querySelectorAll(".power-pod-removal-summary li")).toHaveLength(count as number);
  expect(document.querySelector(".power-pod-removal-remaining")).toBeNull();
});

it.each([
  ["Remove <b>2</b> items <b>pod-a</b>?", "Pods"],
  ["Remove item <b><span>pod-a</span></b>?", "Pods"],
  ["Custom removal of <b>pod-a</b>", "Pods"],
  ["Remove item <b>pod-a</b>?", "UnknownList"],
])("leaves unrelated and customized confirmations unchanged", async (message, root) => {
  const fixture = mount(message, root);
  stop = startPodRemovalConfirmation();
  fixture.remove.click();
  await flush();
  expect(document.querySelector(".power-pod-removal-summary")).toBeNull();
  expect(document.querySelector(".ok")?.textContent).toBe("Remove");
});

it("does not change a later unrelated dialog and restores a reused native message", async () => {
  const fixture = mount();
  stop = startPodRemovalConfirmation();
  fixture.remove.click();
  await flush();
  const dialog = document.querySelector<HTMLElement>(".ConfirmDialog")!;
  const message = dialog.querySelector(".power-pod-removal-original")!;
  message.textContent = "Another operation";
  await flush();
  expect(document.querySelector(".power-pod-removal-summary")).toBeNull();
  expect(message.classList.contains("power-pod-removal-original")).toBe(false);
  dialog.remove();
  const unrelated = document.createElement("div");
  unrelated.className = "ConfirmDialog";
  unrelated.dataset.testid = "confirmation-dialog";
  unrelated.innerHTML =
    '<div class="confirm-content"><p>Remove item <b>pod-a</b>?</p></div><div class="confirm-buttons"><button class="Button ok" data-testid="confirm">Remove</button></div>';
  document.body.append(unrelated);
  await flush();
  expect(unrelated.classList.contains("power-pod-removal")).toBe(false);
});

it("cleans up closed dialogs and cannot reattach after disposal", async () => {
  const fixture = mount();
  stop = startPodRemovalConfirmation();
  fixture.remove.click();
  await flush();
  const dialog = document.querySelector<HTMLElement>(".ConfirmDialog")!;
  delete dialog.dataset.testid;
  await flush();
  expect(dialog.querySelector(".power-pod-removal-summary")).toBeNull();
  stop();
  stop = undefined;
  fixture.remove.click();
  await flush();
  expect(document.querySelector(".power-pod-removal-summary")).toBeNull();
});

it("waits through capture-listener microtasks before the native handler opens the dialog", async () => {
  const fixture = mount();
  const open = fixture.remove.onclick!;
  fixture.remove.onclick = null;
  stop = startPodRemovalConfirmation();
  fixture.remove.click();
  await flush();
  open.call(fixture.remove, new PointerEvent("click"));
  await flush();
  expect(document.querySelectorAll(".power-pod-removal-summary li")).toHaveLength(5);
});

it("expires an unhandled removal click before an unrelated later confirmation", async () => {
  const fixture = mount();
  const open = fixture.remove.onclick!;
  fixture.remove.onclick = null;
  stop = startPodRemovalConfirmation();
  fixture.remove.click();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  open.call(fixture.remove, new PointerEvent("click"));
  await flush();
  expect(document.querySelector(".power-pod-removal-summary")).toBeNull();
});

it("keeps the native message hidden when the host rewrites the dialog classes", async () => {
  const fixture = mount();
  stop = startPodRemovalConfirmation();
  fixture.remove.click();
  await flush();
  const dialog = document.querySelector<HTMLElement>(".ConfirmDialog")!;
  dialog.className = "ConfirmDialog modal native-open";
  const original = dialog.querySelector<HTMLElement>(".power-pod-removal-original")!;
  expect(getComputedStyle(original).display).toBe("none");
  expect(dialog.querySelectorAll(".power-pod-removal-summary li")).toHaveLength(5);
  stop();
  stop = undefined;
  expect(dialog.className).toBe("ConfirmDialog modal native-open");
  expect(getComputedStyle(original).display).not.toBe("none");
});

it("expands the captured selection in the same dialog and collapses it without invoking native actions", async () => {
  const fixture = mount();
  const names = [
    "pod-a",
    "pod-b",
    "pod-c",
    "pod-d",
    "pod-e",
    ...Array.from({ length: 19 }, (_, i) => `pod-extra-${i}`),
  ];
  const expected = [...names];
  const getSelectedNames = vi.fn(() => names);
  const nativeOpen = fixture.remove.onclick!;
  fixture.remove.onclick = (event) => {
    names.splice(0, names.length, "pod-changed");
    nativeOpen.call(fixture.remove, event);
  };
  stop = startPodRemovalConfirmation({ getSelectedNames });
  fixture.remove.click();
  await flush();
  const dialog = document.querySelector(".ConfirmDialog")!;
  const toggle = dialog.querySelector<HTMLButtonElement>(".power-pod-removal-toggle")!;
  expect(getSelectedNames).toHaveBeenCalledOnce();
  expect(toggle.type).toBe("button");
  expect(toggle.textContent).toBe("and 19 more");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.focus();
  expect(document.activeElement).toBe(toggle);
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(dialog.querySelector("ul"));
  // native buttons provide keyboard activation through the browser
  toggle.click();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toBe("Show fewer");
  expect([...dialog.querySelectorAll("li")].map((item) => item.textContent)).toEqual(expected);
  expect(getComputedStyle(dialog.querySelector("ul")!).maxHeight).toBe("40vh");
  expect(fixture.confirm).not.toHaveBeenCalled();
  expect(fixture.cancel).not.toHaveBeenCalled();
  toggle.click();
  expect(dialog.querySelectorAll("li")).toHaveLength(5);
  expect(toggle.textContent).toBe("and 19 more");
  stop();
  stop = undefined;
  expect(dialog.querySelector(".power-pod-removal-toggle")).toBeNull();
  fixture.remove.click();
  await flush();
  expect(getSelectedNames).toHaveBeenCalledOnce();
});

it.each([
  "count",
  "preview",
  "unavailable",
  "throws",
])("keeps a static remainder when the selection snapshot has %s mismatch", async (kind) => {
  const fixture = mount();
  const names = [
    "pod-a",
    "pod-b",
    "pod-c",
    "pod-d",
    "pod-e",
    ...Array.from({ length: 19 }, (_, i) => `pod-extra-${i}`),
  ];
  if (kind === "count") names.pop();
  if (kind === "preview") names[0] = "another-pod";
  stop = startPodRemovalConfirmation({
    getSelectedNames: () => {
      if (kind === "throws") throw new Error("selection unavailable");
      return kind === "unavailable" ? undefined : names;
    },
  });
  fixture.remove.click();
  await flush();
  expect(document.querySelectorAll(".power-pod-removal-summary li")).toHaveLength(5);
  expect(document.querySelector(".power-pod-removal-toggle")).toBeNull();
  expect(document.querySelector(".power-pod-removal-remaining")?.parentElement?.textContent).toBe("and 19 more");
});

it("captures a fresh selection for each removal and clears pending capture on disposal", async () => {
  const fixture = mount();
  let names = ["pod-a", "pod-b", "pod-c", "pod-d", "pod-e", ...Array.from({ length: 19 }, (_, i) => `pod-extra-${i}`)];
  const getSelectedNames = vi.fn(() => names);
  stop = startPodRemovalConfirmation({ getSelectedNames });
  fixture.remove.click();
  await flush();
  expect(document.querySelector(".power-pod-removal-toggle")).not.toBeNull();
  document.querySelector(".ConfirmDialog")!.remove();
  await flush();
  names = ["pod-changed"];
  fixture.remove.click();
  await flush();
  expect(getSelectedNames).toHaveBeenCalledTimes(2);
  expect(document.querySelector(".power-pod-removal-toggle")).toBeNull();
  document.querySelector(".ConfirmDialog")!.remove();
  fixture.remove.onclick = null;
  const clearTimeout = vi.spyOn(window, "clearTimeout");
  fixture.remove.click();
  stop();
  stop = undefined;
  expect(clearTimeout.mock.calls.at(-1)?.[0]).toBeDefined();
  clearTimeout.mockRestore();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  expect(document.querySelector(".power-pod-removal-summary")).toBeNull();
});

it("lists Secrets and expands an immutable captured selection without changing native callbacks", async () => {
  const names = [
    "pod-a",
    "pod-b",
    "pod-c",
    "pod-d",
    "pod-e",
    ...Array.from({ length: 19 }, (_, index) => `secret-${index}`),
  ];
  const fixture = mount(undefined, "Secrets");
  stop = startPodRemovalConfirmation({ getSelectedSecretNames: () => names });
  fixture.remove.click();
  names.splice(0, names.length, "changed");
  await flush();
  expect(document.querySelector(".power-pod-removal-summary p")?.textContent).toBe("Remove 24 secrets?");
  document.querySelector<HTMLButtonElement>(".power-pod-removal-toggle")!.click();
  expect(document.querySelectorAll(".power-pod-removal-summary li")).toHaveLength(24);
  expect(document.querySelector(".power-pod-removal-summary")?.textContent).not.toContain("changed");
  document.querySelector<HTMLButtonElement>('[data-testid="confirm"]')!.click();
  expect(fixture.confirm).toHaveBeenCalledOnce();
});

it.each([
  ["Roles", "roles"],
  ["ClusterRoles", "cluster roles"],
  ["RoleBindings", "role bindings"],
  ["ClusterRoleBindings", "cluster role bindings"],
  ["ServiceAccounts", "service accounts"],
  ["ResourceQuotas", "resource quotas"],
  ["Deployments", "deployments"],
  ["CustomResources", "custom resources"],
])("formats the native %s removal preview without requiring a selected-items store", async (root, label) => {
  const fixture = mount(undefined, root);
  stop = startPodRemovalConfirmation();
  fixture.remove.click();
  await flush();
  expect(document.querySelector(".power-pod-removal-summary p")?.textContent).toBe(`Remove 24 ${label}?`);
  expect(document.querySelectorAll(".power-pod-removal-summary li")).toHaveLength(5);
  expect(document.querySelector(".power-pod-removal-toggle")).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid="confirm"]')!.click();
  expect(fixture.confirm).toHaveBeenCalledOnce();
});

it("captures an available resource store snapshot for expansion without reading any values", async () => {
  const names = [
    "pod-a",
    "pod-b",
    "pod-c",
    "pod-d",
    "pod-e",
    ...Array.from({ length: 19 }, (_, index) => `role-${index}`),
  ];
  const selected = vi.fn((root: string) => (root === "Roles" ? names : undefined));
  const fixture = mount(undefined, "Roles");
  stop = startPodRemovalConfirmation({ getSelectedResourceNames: selected });
  fixture.remove.click();
  names.splice(0, names.length, "changed");
  await flush();
  document.querySelector<HTMLButtonElement>(".power-pod-removal-toggle")!.click();
  expect(document.querySelectorAll(".power-pod-removal-summary li")).toHaveLength(24);
  expect(selected).toHaveBeenCalledExactlyOnceWith("Roles");
});

it("keeps colon-separated RBAC names readable and preserves native namespace warnings", async () => {
  const fixture = mount("Remove item <b>system:example-role</b>?", "ClusterRoles");
  stop = startPodRemovalConfirmation();
  fixture.remove.click();
  await flush();
  expect(document.querySelector(".power-pod-removal-summary code")?.textContent).toBe("system:example-role");
  stop();
  const namespace = mount(
    'Type namespace <b>example</b> to delete all resources <input required><label><input type="checkbox">Confirm deletion</label>',
    "Namespaces",
  );
  stop = startPodRemovalConfirmation();
  namespace.remove.click();
  await flush();
  expect(document.querySelector(".power-pod-removal-summary")).toBeNull();
  expect(document.querySelector(".confirm-content input[required]")).toBeTruthy();
  expect(document.querySelector('.confirm-content input[type="checkbox"]')).toBeTruthy();
});
