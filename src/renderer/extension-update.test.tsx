// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import ReactDOM from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ install: vi.fn(), error: vi.fn(), close: vi.fn() }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Component: { Notifications: { error: mocks.error } } },
}));

import { startExtensionUpdate } from "./extension-update";

let stop: (() => void) | undefined;
let form: HTMLElement;
function Install({ initial = "", disabled = false }: { initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <section>
      <input
        placeholder="Name or file path or URL"
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
  return `<div class="tr"><div class="td extension"><div><div><div>${name}</div><div>Description</div></div></div></div>
    <div class="td actions"><span id="menu-actions-for-installed-extensions-for-${id}">more_vert</span></div></div>`;
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
  document.body.innerHTML = `<div data-testid="extensions-page"><div id="install-root"></div><section data-testid="extensions-table">
    ${row("@64mb/freelens-power", "power")}${row("@example/other", "other")}
    ${row("@64mb/freelens-power-extra", "similar")}</section></div>`;
  form = document.getElementById("install-root")!;
  act(() => {
    ReactDOM.render(<Install />, form);
  });
  document
    .querySelector('[id="menu-actions-for-installed-extensions-for-power"]')!
    .addEventListener("click", mocks.close);
});
afterEach(() => {
  act(() => {
    stop?.();
    ReactDOM.unmountComponentAtNode(form);
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
  fireEvent.change(screen.getByPlaceholderText("Name or file path or URL"), { target: { value: "neutral-package" } });
  await start();
  fireEvent.click(screen.getByLabelText("Update Freelens Power"));
  await waitFor(() => expect(mocks.install).toHaveBeenCalledExactlyOnceWith("@64mb/freelens-power@latest"));
  expect(screen.getByPlaceholderText("Name or file path or URL")).toHaveProperty("value", "neutral-package");
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
  fireEvent.change(screen.getByPlaceholderText("Name or file path or URL"), { target: { value: "neutral-package" } });
  await start();
  fireEvent.click(screen.getByLabelText("Update Freelens Power"));
  await waitFor(() => expect(downloaded).toBeDefined());
  expect(screen.getByPlaceholderText("Name or file path or URL")).toHaveProperty("value", "neutral-package");
  await act(async () => {
    downloaded();
  });
  expect(captured).toBe("@64mb/freelens-power@latest");
  screen.getByText("Confirm replacement").remove();
  expect(screen.getByPlaceholderText("Name or file path or URL")).toHaveProperty("value", "neutral-package");
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
  fireEvent.change(screen.getByPlaceholderText("Name or file path or URL"), { target: { value: "neutral-package" } });
  await start();
  fireEvent.click(screen.getByLabelText("Update Freelens Power"));
  document.querySelector<HTMLButtonElement>('[data-testid="extensions-page"] button')!.disabled = true;
  await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
  expect(screen.getByPlaceholderText("Name or file path or URL")).toHaveProperty("value", "neutral-package");
  expect(mocks.install).not.toHaveBeenCalled();
});
it("removes controls and restores the draft on disable before handoff", async () => {
  fireEvent.change(screen.getByPlaceholderText("Name or file path or URL"), { target: { value: "neutral-package" } });
  const menu = await start();
  fireEvent.click(screen.getByLabelText("Update Freelens Power"));
  act(() => {
    stop?.();
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(menu.querySelector("[data-power-extension-update]")).toBeNull();
  expect(screen.getByPlaceholderText("Name or file path or URL")).toHaveProperty("value", "neutral-package");
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
    ReactDOM.render(<Install disabled />, form);
  });
  await start();
  const update = screen.getByLabelText("Update Freelens Power");
  expect(update.classList.contains("disabled")).toBe(true);
  fireEvent.click(update);
  expect(mocks.install).not.toHaveBeenCalled();
  act(() => {
    stop?.();
  });
  vi.stubGlobal("process", { isMainFrame: false });
  await act(async () => {
    stop = startExtensionUpdate();
  });
  expect(screen.queryByLabelText("Update Freelens Power")).toBeNull();
});
