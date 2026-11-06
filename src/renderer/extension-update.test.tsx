// @vitest-environment jsdom

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubMainFrame } from "./frame.test-utils";
import { renderIntoContainer, unmountContainer } from "./react-roots.test-utils";

const mocks = vi.hoisted(() => ({ install: vi.fn(), error: vi.fn(), close: vi.fn(), navigate: vi.fn() }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Navigation: { navigate: mocks.navigate }, Component: { Notifications: { error: mocks.error } } },
}));

import { requestExtensionUpdate, startExtensionUpdate } from "./extension-update";

let stop: (() => void) | undefined;
let form: HTMLElement;
function Install({ initial = "", disabled = false }: { initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <section>
      <input
        placeholder="Name, URL, or path to a package or directory"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          void Promise.resolve(mocks.install(value)).then(() => {
            const confirm = document.createElement("button");
            confirm.textContent = "Confirm replacement";
            confirm.onclick = () => mocks.install("confirmed");
            document.body.append(confirm);
          });
        }}
      >
        Install
      </button>
    </section>
  );
}
function row(name: string, id: string) {
  return `<tr><td class="sortable-table_td_a1"><div><div class="installed-extensions_extensionName_b2">${name}</div><div>Description</div></div></td>
    <td class="sortable-table_td_a1"><span id="menu-actions-for-installed-extensions-for-${id}">more_vert</span></td></tr>`;
}
function openMenu(id = "power") {
  const menu = document.createElement("ul");
  menu.className = "Menu MenuActions";
  menu.id = `menu-actions-for-installed-extensions-for-${id}`;
  menu.innerHTML =
    '<li class="MenuItem" tabindex="0"><i class="Icon material focusable"><span class="icon" data-icon-name="unpublished">unpublished</span></i><span class="title">Disable</span></li><li class="MenuItem" tabindex="0">Uninstall</li>';
  document.body.append(menu);
  return menu;
}
async function start(id = "power") {
  const menu = openMenu(id);
  await act(async () => {
    stop = startExtensionUpdate();
  });
  return menu;
}
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = `<div data-testid="extensions-page"><div id="install-root"></div><section data-testid="extensions-table"><table><tbody>
    ${row("@64mb/freelens-power", "power")}${row("@example/other", "other")}
    ${row("@64mb/freelens-power-extra", "similar")}</tbody></table></section></div>`;
  form = document.getElementById("install-root")!;
  act(() => {
    renderIntoContainer(<Install />, form);
  });
  document
    .querySelector('[id="menu-actions-for-installed-extensions-for-power"]')!
    .addEventListener("click", mocks.close);
});
afterEach(() => {
  act(() => {
    stop?.();
    unmountContainer(form);
  });
  stop = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("adds one native Update action only to the exact Power row menu", async () => {
  const other = openMenu("other");
  const similar = openMenu("similar");
  const menu = await start();
  expect(screen.getAllByLabelText("Update Freelens Power")).toHaveLength(1);
  expect(menu.querySelector("[data-power-extension-update] .Icon")?.textContent).toBe("system_update_alt");
  expect(other.querySelector("[data-power-extension-update]")).toBeNull();
  expect(similar.querySelector("[data-power-extension-update]")).toBeNull();
  await act(async () => {
    menu.append(document.createElement("span"));
  });
  expect(screen.getAllByLabelText("Update Freelens Power")).toHaveLength(1);
});
it("updates the React controlled native install form and leaves replacement confirmation to the user", async () => {
  await start();
  fireEvent.click(screen.getByLabelText("Update Freelens Power"));
  await waitFor(() => expect(mocks.install).toHaveBeenCalledExactlyOnceWith("@64mb/freelens-power@latest"));
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(screen.getByText("Confirm replacement")).toBeTruthy();
  expect(mocks.install).not.toHaveBeenCalledWith("confirmed");
  expect(mocks.error).not.toHaveBeenCalled();
});
it("preserves an unrelated install draft while the native confirmation waits for the user", async () => {
  fireEvent.change(screen.getByPlaceholderText("Name, URL, or path to a package or directory"), {
    target: { value: "neutral-package" },
  });
  await start();
  fireEvent.click(screen.getByLabelText("Update Freelens Power"));
  await waitFor(() => expect(mocks.install).toHaveBeenCalledExactlyOnceWith("@64mb/freelens-power@latest"));
  expect(screen.getByPlaceholderText("Name, URL, or path to a package or directory")).toHaveProperty(
    "value",
    "neutral-package",
  );
  expect(mocks.install).not.toHaveBeenCalledWith("confirmed");
});
it("keeps the synchronously captured native target across asynchronous download and cancellation", async () => {
  let downloaded!: () => void;
  let captured = "";
  mocks.install.mockImplementationOnce(async (target: string) => {
    await new Promise<void>((resolve) => {
      downloaded = resolve;
    });
    captured = target;
  });
  fireEvent.change(screen.getByPlaceholderText("Name, URL, or path to a package or directory"), {
    target: { value: "neutral-package" },
  });
  await start();
  fireEvent.click(screen.getByLabelText("Update Freelens Power"));
  await waitFor(() => expect(downloaded).toBeDefined());
  expect(screen.getByPlaceholderText("Name, URL, or path to a package or directory")).toHaveProperty(
    "value",
    "neutral-package",
  );
  await act(async () => {
    downloaded();
  });
  expect(captured).toBe("@64mb/freelens-power@latest");
  screen.getByText("Confirm replacement").remove();
  expect(screen.getByPlaceholderText("Name, URL, or path to a package or directory")).toHaveProperty(
    "value",
    "neutral-package",
  );
  expect(mocks.install).not.toHaveBeenCalledWith("confirmed");
});
it("supports native keyboard navigation and activates Update with Enter", async () => {
  const menu = await start();
  const update = screen.getByLabelText("Update Freelens Power");
  const disable = menu.querySelector<HTMLElement>(":scope > .MenuItem:not([data-power-extension-update])")!;
  disable.focus();
  fireEvent.keyDown(disable, { key: "ArrowUp", code: "ArrowUp" });
  expect(document.activeElement).toBe(update);
  fireEvent.keyDown(update, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(mocks.install).toHaveBeenCalledExactlyOnceWith("@64mb/freelens-power@latest"));
});
it("restores a native install draft if the handoff cannot start", async () => {
  fireEvent.change(screen.getByPlaceholderText("Name, URL, or path to a package or directory"), {
    target: { value: "neutral-package" },
  });
  await start();
  fireEvent.click(screen.getByLabelText("Update Freelens Power"));
  document.querySelector<HTMLButtonElement>('[data-testid="extensions-page"] button')!.disabled = true;
  await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
  expect(screen.getByPlaceholderText("Name, URL, or path to a package or directory")).toHaveProperty(
    "value",
    "neutral-package",
  );
  expect(mocks.install).not.toHaveBeenCalled();
});
it("removes controls and restores the draft on disable before handoff", async () => {
  fireEvent.change(screen.getByPlaceholderText("Name, URL, or path to a package or directory"), {
    target: { value: "neutral-package" },
  });
  const menu = await start();
  fireEvent.click(screen.getByLabelText("Update Freelens Power"));
  act(() => {
    stop?.();
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(menu.querySelector("[data-power-extension-update]")).toBeNull();
  expect(screen.getByPlaceholderText("Name, URL, or path to a package or directory")).toHaveProperty(
    "value",
    "neutral-package",
  );
  expect(mocks.install).not.toHaveBeenCalled();
});
it("remounts after a native menu rerender and cleans up when Extensions closes", async () => {
  const menu = await start();
  await act(async () => {
    menu.remove();
    openMenu();
  });
  expect(screen.getAllByLabelText("Update Freelens Power")).toHaveLength(1);
  await act(async () => {
    document.querySelector('[data-testid="extensions-table"]')!.remove();
  });
  expect(screen.queryByLabelText("Update Freelens Power")).toBeNull();
});
it("does not install while the native installer is busy or inside a cluster frame", async () => {
  act(() => {
    renderIntoContainer(<Install disabled />, form);
  });
  await start();
  const update = screen.getByLabelText("Update Freelens Power");
  expect(update.classList.contains("disabled")).toBe(true);
  fireEvent.click(update);
  expect(mocks.install).not.toHaveBeenCalled();
  act(() => {
    stop?.();
  });
  stubMainFrame(false);
  await act(async () => {
    stop = startExtensionUpdate();
  });
  expect(screen.queryByLabelText("Update Freelens Power")).toBeNull();
});

it("navigates to Extensions and waits for native installation controls without accepting confirmation", async () => {
  vi.useFakeTimers();
  const page = document.querySelector('[data-testid="extensions-page"]')!;
  page.remove();
  await act(async () => {
    stop = startExtensionUpdate();
  });
  requestExtensionUpdate();
  requestExtensionUpdate();
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/extensions");
  expect(mocks.install).not.toHaveBeenCalled();
  await act(async () => {
    document.body.append(page);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("@64mb/freelens-power@latest");
  expect(screen.getByText("Confirm replacement")).toBeTruthy();
  expect(mocks.install).not.toHaveBeenCalledWith("confirmed");
  stop?.();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
it("reports an unavailable installer after navigation and cancels a pending request on teardown", async () => {
  vi.useFakeTimers();
  document.querySelector('[data-testid="extensions-page"]')!.remove();
  await act(async () => {
    stop = startExtensionUpdate();
  });
  requestExtensionUpdate();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    "Could not open the native extension installer. Open Extensions and retry",
  );
  expect(mocks.install).not.toHaveBeenCalled();
  requestExtensionUpdate();
  stop?.();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(mocks.error).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
