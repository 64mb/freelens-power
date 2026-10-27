// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { startHostPreferencesStyles } from "./host-preferences";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@freelensapp/extensions", () => ({ Renderer: { Navigation: { navigate } } }));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  navigate.mockClear();
});

function mount(role = "", tabindex = "") {
  document.body.innerHTML = `
    <div class="Preferences SettingLayout"><nav class="sidebarRegion">
      <div data-preference-tab-group-test="extensions-tab-group">
        <div class="header" ${role} ${tabindex}><span>Extensions</span></div>
        <div class="Tab" role="tab" tabindex="0">Extension settings</div>
      </div>
    </nav></div><div class="header">Other header</div>`;
  return document.querySelector<HTMLElement>(".sidebarRegion .header")!;
}

it("connects a later mounted header and preserves child nodes and other navigation", async () => {
  stop = startHostPreferencesStyles();
  const header = mount();
  const child = header.firstElementChild;
  await Promise.resolve();
  expect(header.getAttribute("role")).toBe("link");
  expect(header.tabIndex).toBe(0);
  expect(header.firstElementChild).toBe(child);
  child!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  header.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  header.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  document.querySelector(".Tab")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(navigate.mock.calls).toEqual([["/extensions"], ["/extensions"]]);
  expect(document.querySelector("body > .header")!.hasAttribute("role")).toBe(false);
  expect(document.querySelector(".Tab")!.getAttribute("role")).toBe("tab");
  stop();
  expect(header.hasAttribute("role")).toBe(false);
  expect(header.hasAttribute("tabindex")).toBe(false);
  expect(document.querySelector('[data-freelens-power="host-preferences"]')).toBeNull();
  header.click();
  expect(navigate).toHaveBeenCalledTimes(2);
  const replacement = mount();
  await Promise.resolve();
  expect(replacement.hasAttribute("role")).toBe(false);
});

it("restores original attributes on replaced headers and on disposal", async () => {
  const initial = mount('role="heading"', 'tabindex="-1"');
  stop = startHostPreferencesStyles();
  const replacement = mount('role="button"', 'tabindex="2"');
  await Promise.resolve();
  expect(initial.getAttribute("role")).toBe("heading");
  expect(initial.tabIndex).toBe(-1);
  initial.click();
  expect(navigate).not.toHaveBeenCalled();
  expect(replacement.getAttribute("role")).toBe("link");
  stop();
  expect(replacement.getAttribute("role")).toBe("button");
  expect(replacement.tabIndex).toBe(2);
});

it("replaces only the Power preference emoji with a native icon and restores late mounted tabs", async () => {
  mount();
  stop = startHostPreferencesStyles();
  const group = document.querySelector('[data-preference-tab-group-test="extensions-tab-group"]')!;
  const tab = document.createElement("div");
  tab.className = "Tab active";
  tab.setAttribute("data-preference-tab-link-test", "freelens-power");
  tab.innerHTML = "<span><span>🔋 Freelens Power</span></span>";
  const text = tab.querySelector("span span")!.firstChild;
  const sibling = document.createElement("div");
  sibling.innerHTML = '<div class="label">🔋 Another extension</div>';
  group.append(tab, sibling);
  await Promise.resolve();
  expect(tab.textContent).toBe("Freelens Power");
  expect(tab.className).toBe("Tab active");
  tab.className = "Tab";
  await Promise.resolve();
  expect(tab.textContent).toBe("Freelens Power");
  expect(tab.querySelector("span span")!.firstChild).toBe(text);
  expect(sibling.textContent).toBe("🔋 Another extension");
  stop();
  expect(tab.textContent).toBe("🔋 Freelens Power");
  expect(tab.className).toBe("Tab");
});
