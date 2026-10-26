// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCENT_COLOR_OPTIONS,
  AppearancePreferencesStore,
  DEFAULT_ACCENT_COLOR,
} from "../common/store/appearance-preferences-store";
import { accentForeground, startAppearanceOverride } from "./appearance";

vi.mock("@freelensapp/extensions", () => ({
  Common: {
    Store: {
      ExtensionStore: class {
        static instance: unknown;

        static getInstanceOrCreate() {
          return (this.instance ??= new this());
        }
      },
    },
  },
}));

describe("application accent override", () => {
  let dispose: (() => void) | undefined;
  let preferences: AppearancePreferencesStore;

  beforeEach(() => {
    preferences = AppearancePreferencesStore.getInstanceOrCreate<AppearancePreferencesStore>();
    runInAction(() => preferences.fromStore({ enabled: true, accentColor: DEFAULT_ACCENT_COLOR }));
    document.documentElement.style.setProperty("--primary", "#00a7a0");
    document.documentElement.style.setProperty("--colorSuccess", "#43a047");
  });

  afterEach(() => {
    dispose?.();
    document.documentElement.removeAttribute("style");
    document.head.innerHTML = "";
  });

  function accentRule(): CSSStyleRule | undefined {
    return rules().find((rule) => rule.selectorText === ":root");
  }

  function rules(): CSSStyleRule[] {
    const style = document.querySelector<HTMLStyleElement>('style[data-freelens-power="accent-color"]');
    return Array.from(style?.sheet?.cssRules ?? []) as CSSStyleRule[];
  }

  it.each(ACCENT_COLOR_OPTIONS)("chooses readable text for the $label accent", ({ color }) => {
    const linear = [1, 3, 5].map((offset) => {
      const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    const foreground = accentForeground(color);
    const contrast = foreground === "#000000" ? (luminance + 0.05) / 0.05 : 1.05 / (luminance + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    expect(contrast).toBeGreaterThanOrEqual(
      foreground === "#ffffff" ? (luminance + 0.05) / 0.05 : 1.05 / (luminance + 0.05),
    );
  });

  it("keeps selected and focused options readable and scopes sidebar text and icon inheritance", () => {
    dispose = startAppearanceOverride();
    expect(accentForeground("#000000")).toBe("#ffffff");
    expect(accentForeground("#ffffff")).toBe("#000000");
    expect(accentForeground(DEFAULT_ACCENT_COLOR)).toBe("#ffffff");
    expect(accentRule()?.style.getPropertyValue("--freelens-power-accent-foreground")).toBe("#ffffff");
    const selectedRule = rules().find((rule) => rule.selectorText === ":root .Select__option--is-selected");
    expect(selectedRule?.style.getPropertyValue("color")).toBe("var(--freelens-power-accent-foreground)");
    expect(accentRule()?.style.getPropertyValue("--select-option-focused-color")).toBe("var(--textColorAccent)");
    const sidebarRule = () => rules().find((rule) => rule.selectorText === ':root [data-testid="cluster-sidebar"]');
    expect(sidebarRule()?.style.getPropertyValue("--sidebarSubmenuActiveColor")).toBe("var(--primary)");
    expect(sidebarRule()?.style.getPropertyValue("--sidebarActiveColor")).toBe(
      "var(--freelens-power-accent-foreground)",
    );
    expect(accentRule()?.style.getPropertyValue("--sidebarSubmenuActiveColor")).toBe("");
    runInAction(() => {
      preferences.accentColor = "#edc927";
    });
    expect(accentRule()?.style.getPropertyValue("--freelens-power-accent-foreground")).toBe("#000000");
    runInAction(() => {
      preferences.enabled = false;
    });
    expect(sidebarRule()).toBeUndefined();
    expect(accentRule()).toBeUndefined();
  });

  it("scopes the native log download accent and restores its host color when disabled", () => {
    dispose = startAppearanceOverride();
    const downloadRule = () =>
      rules().find((rule) => rule.selectorText.includes('[data-testid="download-logs-dropdown"]'));
    expect(downloadRule()?.style.getPropertyValue("--accent-color")).toBe("var(--primary)");
    expect(accentRule()?.style.getPropertyValue("--colorInfo")).toBe("");
    runInAction(() => {
      preferences.accentColor = "default";
    });
    expect(downloadRule()).toBeUndefined();
    runInAction(() => {
      preferences.accentColor = DEFAULT_ACCENT_COLOR;
    });
    expect(downloadRule()).toBeDefined();
    dispose();
    expect(downloadRule()).toBeUndefined();
  });

  it("accents the sidebar resize handle and dock creation menu without changing status colors", () => {
    document.body.innerHTML = `
      <div class="main-layout-module__sidebar--example"><div class="ResizingAnchor horizontal"></div></div>
      <div class="Menu"><div class="MenuItem create-terminal-tab"></div><div class="MenuItem create-resource-tab"></div></div>
      <div class="MenuItem resource-status"></div><div class="Nodes"><div class="ResizingAnchor"></div></div>
    `;
    try {
      dispose = startAppearanceOverride();
      const sidebarRule = () => rules().find((rule) => rule.selectorText.includes("main-layout-module__sidebar--"));
      const dockRule = () => rules().find((rule) => rule.selectorText.includes("create-terminal-tab"));
      expect(document.querySelectorAll(sidebarRule()!.selectorText)).toHaveLength(1);
      expect(document.querySelectorAll(dockRule()!.selectorText)).toHaveLength(2);
      expect(sidebarRule()?.style.getPropertyValue("--blue")).toBe("var(--primary)");
      expect(dockRule()?.style.getPropertyValue("--bgc-active")).toBe("var(--primary)");
      expect(accentRule()?.style.getPropertyValue("--menuActiveBackground")).toBe("");
      expect(accentRule()?.style.getPropertyValue("--colorSuccess")).toBe("");
      runInAction(() => {
        preferences.accentColor = "default";
      });
      expect(sidebarRule()).toBeUndefined();
      expect(dockRule()).toBeUndefined();
      runInAction(() => {
        preferences.accentColor = DEFAULT_ACCENT_COLOR;
        preferences.enabled = false;
      });
      expect(sidebarRule()).toBeUndefined();
      expect(dockRule()).toBeUndefined();
    } finally {
      document.body.innerHTML = "";
    }
  });

  it.each(
    ACCENT_COLOR_OPTIONS.filter((option) => option.value !== "default"),
  )("persists and applies the $label accent preset", ({ value, color }) => {
    runInAction(() => preferences.fromStore({ enabled: true, accentColor: value }));
    expect(preferences.toJSON().accentColor).toBe(value);
    dispose = startAppearanceOverride();
    expect(accentRule()?.style.getPropertyValue("--primary")).toBe(color);
  });

  it("applies accent variables with priority over inline theme values and preserves status colors", () => {
    dispose = startAppearanceOverride();

    for (const variable of ["--primary", "--buttonPrimaryBackground", "--icon-focus-color"]) {
      expect(accentRule()?.style.getPropertyValue(variable)).toBe(DEFAULT_ACCENT_COLOR);
      expect(accentRule()?.style.getPropertyPriority(variable)).toBe("important");
    }

    expect(accentRule()?.selectorText).toBe(":root");
    expect(accentRule()?.style.getPropertyValue("--colorSuccess")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--colorSuccess")).toBe("#43a047");
  });

  it("preserves the native palette used by CPU and memory utilization fills across theme changes", () => {
    const nativePalette = { "--blue": "#2196f3", "--magenta": "#ca52ab" };
    for (const [variable, value] of Object.entries(nativePalette)) {
      document.documentElement.style.setProperty(variable, value);
    }
    dispose = startAppearanceOverride();

    for (const [variable, value] of Object.entries(nativePalette)) {
      expect(accentRule()?.style.getPropertyValue(variable)).toBe("");
      expect(getComputedStyle(document.documentElement).getPropertyValue(variable)).toBe(value);
      document.documentElement.style.setProperty(variable, "#abcdef");
      expect(getComputedStyle(document.documentElement).getPropertyValue(variable)).toBe("#abcdef");
    }
    expect(accentRule()?.style.getPropertyValue("--primary")).toBe(DEFAULT_ACCENT_COLOR);
    expect(accentRule()?.style.getPropertyValue("--buttonPrimaryBackground")).toBe(DEFAULT_ACCENT_COLOR);
  });

  it("accents focused native Select controls globally while excluding disabled controls", () => {
    dispose = startAppearanceOverride();
    const selector =
      ":root .Select:not(.Select--is-disabled) .Select__control--is-focused:not(.Select__control--is-disabled)";
    const focusedRule = () => rules().find((rule) => rule.selectorText === selector);
    const normalizedColor = document.createElement("div").style;
    normalizedColor.borderColor = DEFAULT_ACCENT_COLOR;
    expect(focusedRule()?.style.getPropertyValue("border-color")).toBe(normalizedColor.borderColor);
    expect(focusedRule()?.style.getPropertyValue("box-shadow")).toBe(`0 0 0 1px ${DEFAULT_ACCENT_COLOR}`);
    expect(focusedRule()?.style.getPropertyPriority("box-shadow")).toBe("important");
    document.body.innerHTML =
      '<div class="Select"><div class="Select__control Select__control--is-focused"></div><div class="Select__control--is-focused Select__control--is-disabled"></div></div><div class="Select Select--is-disabled"><div class="Select__control--is-focused"></div></div>';
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    runInAction(() => {
      preferences.accentColor = "#0273ee";
    });
    expect(focusedRule()?.style.getPropertyValue("box-shadow")).toBe("0 0 0 1px #0273ee");
    runInAction(() => {
      preferences.accentColor = "default";
    });
    expect(focusedRule()).toBeUndefined();
    runInAction(() => {
      preferences.accentColor = DEFAULT_ACCENT_COLOR;
      preferences.enabled = false;
    });
    expect(focusedRule()).toBeUndefined();
    document.body.innerHTML = "";
  });

  it("accents native checkboxes and drawer controls without recoloring resource utilization", () => {
    const hostStyle = document.createElement("style");
    hostStyle.textContent = `
      .Checkbox { --checkbox-bgc-active: var(--blue); }
      .theme-light .Checkbox { --checkbox-color-active: var(--blue); }
      .Drawer .drawer-title { background: var(--blue); }
      .Drawer .ResizingAnchor:hover::after, .Drawer .ResizingAnchor.resizing::after { background: var(--blue); }
      .DrawerParamToggler .param-link-text, .Nodes .cpu .LineProgress { color: var(--blue); }
      .Nodes .memory .LineProgress { color: var(--magenta); }
    `;
    document.head.append(hostStyle);
    document.body.innerHTML = `
      <label class="Checkbox"><input type="checkbox" checked /><i class="box"></i></label>
      <div class="theme-light"><label class="Checkbox"><input type="checkbox" checked /><i class="box"></i></label></div>
      <div class="Drawer"><div class="drawer-title">Pod</div><div class="ResizingAnchor horizontal"></div><div class="drawer-content">
        <div class="DrawerParamToggler"><div class="param-link"><span class="param-link-text">Show</span></div></div>
        <div class="Nodes"><div class="cpu"><div class="LineProgress"></div></div>
          <div class="memory"><div class="LineProgress"></div></div></div>
      </div></div>
    `;
    try {
      dispose = startAppearanceOverride();
      const controlRule = () => rules().find((rule) => rule.style.getPropertyValue("--blue"));
      const selector = controlRule()!.selectorText;
      expect(document.querySelectorAll(selector)).toHaveLength(5);
      expect(controlRule()?.style.getPropertyValue("--blue")).toBe("var(--primary)");
      for (const control of document.querySelectorAll(selector)) {
        expect(getComputedStyle(control).getPropertyValue("--blue")).toBe("var(--primary)");
      }
      for (const bar of document.querySelectorAll(".LineProgress")) {
        expect(bar.matches(selector)).toBe(false);
        expect(bar.closest(".Checkbox, .drawer-title, .param-link")).toBeNull();
      }
      expect(accentRule()?.style.getPropertyValue("--blue")).toBe("");

      runInAction(() => {
        preferences.accentColor = "default";
      });
      expect(controlRule()).toBeUndefined();
      runInAction(() => {
        preferences.accentColor = DEFAULT_ACCENT_COLOR;
        preferences.enabled = false;
      });
      expect(controlRule()).toBeUndefined();
      expect(hostStyle.isConnected).toBe(true);
      for (const control of document.querySelectorAll(selector)) {
        expect(getComputedStyle(control).getPropertyValue("--blue")).toBe("");
      }
    } finally {
      document.body.innerHTML = "";
    }
  });

  it("accents only selected native Catalog tree items and restores the host palette", () => {
    const selector = ':root [role="treeitem"][class*="catalog-tree-module__selected--"]';
    document.body.innerHTML = `
      <ul role="tree">
        <li role="treeitem" class="catalog-tree-module__root--native catalog-tree-module__selected--native tree-view-module__selected--native">Web Links</li>
        <li role="treeitem" class="catalog-tree-module__root--native">Clusters</li>
        <li role="treeitem" class="tree-view-module__selected--native">Other tree</li>
      </ul>
    `;
    try {
      dispose = startAppearanceOverride();
      const catalogRule = () => rules().find((rule) => rule.selectorText === selector);
      expect(catalogRule()?.style.getPropertyValue("--blue")).toBe("var(--primary)");
      expect(document.querySelectorAll(selector)).toHaveLength(1);
      expect(document.querySelector(selector)?.textContent).toBe("Web Links");

      const selected = document.querySelector(selector)!;
      const next = document.querySelectorAll('[role="treeitem"]')[1]!;
      selected.classList.remove("catalog-tree-module__selected--native");
      next.classList.add("catalog-tree-module__selected--native");
      expect(document.querySelectorAll(selector)).toHaveLength(1);
      expect(document.querySelector(selector)?.textContent).toBe("Clusters");

      runInAction(() => {
        preferences.accentColor = "default";
      });
      expect(catalogRule()).toBeUndefined();
      runInAction(() => {
        preferences.accentColor = DEFAULT_ACCENT_COLOR;
      });
      expect(catalogRule()).toBeDefined();
      runInAction(() => {
        preferences.enabled = false;
      });
      expect(catalogRule()).toBeUndefined();
    } finally {
      document.body.innerHTML = "";
    }
  });

  it("updates the color and restores the latest theme on disable", () => {
    dispose = startAppearanceOverride();
    runInAction(() => {
      preferences.accentColor = "#0273ee";
    });
    expect(accentRule()?.style.getPropertyValue("--primary")).toBe("#0273ee");

    document.documentElement.style.setProperty("--primary", "#abcdef");
    expect(accentRule()?.style.getPropertyPriority("--primary")).toBe("important");
    runInAction(() => {
      preferences.enabled = false;
    });
    expect(accentRule()).toBeUndefined();
    expect(rules()).toHaveLength(0);
    expect(getComputedStyle(document.documentElement).getPropertyValue("--primary")).toBe("#abcdef");

    runInAction(() => {
      preferences.enabled = true;
    });
    expect(accentRule()?.style.getPropertyValue("--primary")).toBe("#0273ee");
  });

  it("uses the latest host theme for default selection while keeping native switches accented", () => {
    dispose = startAppearanceOverride();
    document.documentElement.style.setProperty("--primary", "#abcdef");
    runInAction(() => {
      preferences.accentColor = "default";
    });

    expect(accentRule()).toBeUndefined();
    expect(getComputedStyle(document.documentElement).getPropertyValue("--primary")).toBe("#abcdef");
    expect(rules()).toHaveLength(1);
    expect(rules()[0]?.selectorText).toBe('input[role="switch"]');
    expect(rules()[0]?.style.getPropertyValue("--track-color-active")).toBe("var(--primary)");
    expect(rules()[0]?.style.getPropertyPriority("--track-color-active")).toBe("important");

    runInAction(() => {
      preferences.accentColor = "#0273ee";
    });
    expect(accentRule()?.style.getPropertyValue("--primary")).toBe("#0273ee");
  });

  it("accents link text and only the teal paths in the welcome logo", () => {
    dispose = startAppearanceOverride();
    const linkRule = rules().find((rule) => rule.selectorText === ":root a.link");
    expect(linkRule?.selectorText).toBe(":root a.link");
    expect(linkRule?.style.getPropertyValue("color")).toBe("var(--primary)");
    document.body.innerHTML =
      '<nav><a href="/nodes">Nodes</a></nav><a class="link" href="https://example.com">Documentation</a>';
    expect(document.querySelectorAll(linkRule!.selectorText)).toHaveLength(1);
    expect(document.querySelector(linkRule!.selectorText)?.textContent).toBe("Documentation");

    const logoRule = rules().find((rule) => rule.style.getPropertyValue("fill"));
    expect(logoRule?.style.getPropertyValue("fill")).toBe("var(--primary)");
    document.body.innerHTML = `<div class="Welcome"><span data-testid="no-welcome-banners-icon"><svg><path fill="#fbfbfb"/><path fill="#23a49c"/></svg></span><svg><path fill="#23a49c"/></svg></div>`;
    expect(document.querySelectorAll(logoRule?.selectorText ?? "path")).toHaveLength(1);
    expect(document.querySelector(logoRule?.selectorText ?? "path")?.getAttribute("fill")).toBe("#23a49c");
    runInAction(() => {
      preferences.recolorAppIcon = false;
    });
    expect(rules().some((rule) => rule.style.getPropertyValue("fill"))).toBe(false);
    expect(accentRule()?.style.getPropertyValue("--primary")).toBe(DEFAULT_ACCENT_COLOR);
    runInAction(() => {
      preferences.recolorAppIcon = true;
    });
    expect(rules().some((rule) => rule.style.getPropertyValue("fill"))).toBe(true);
    document.body.innerHTML = "";
  });

  it("removes the override on disposal and stops reacting", () => {
    dispose = startAppearanceOverride();
    dispose();
    runInAction(() => {
      preferences.accentColor = "#0273ee";
    });
    expect(accentRule()).toBeUndefined();
    expect(rules()).toHaveLength(0);
    expect(getComputedStyle(document.documentElement).getPropertyValue("--primary")).toBe("#00a7a0");
  });

  it("does not create a stylesheet when initially disabled", () => {
    runInAction(() => {
      preferences.enabled = false;
    });
    dispose = startAppearanceOverride();
    expect(accentRule()).toBeUndefined();
  });

  it("migrates saved palette choices to the refined shades", () => {
    for (const [oldColor, newColor] of [
      ["#7868f4", "#7060e8"],
      ["#027bfe", "#0273ee"],
      ["#ffc107", "#edc927"],
      ["#009688", "default"],
    ]) {
      runInAction(() => preferences.fromStore({ accentColor: oldColor }));
      expect(preferences.accentColor).toBe(newColor);
    }
  });

  it("persists icon opt-out independently of accent selection", () => {
    runInAction(() => preferences.fromStore({ enabled: true, accentColor: "#0273ee", recolorAppIcon: false }));
    expect(preferences.toJSON()).toEqual({ enabled: true, accentColor: "#0273ee", recolorAppIcon: false });
    dispose = startAppearanceOverride();
    expect(accentRule()).toBeTruthy();
  });

  it("rejects invalid persisted colors and blocks CSS injection at runtime", () => {
    runInAction(() => preferences.fromStore({ accentColor: "red; --colorSuccess: red" }));
    expect(preferences.toJSON()).toEqual({ enabled: true, accentColor: DEFAULT_ACCENT_COLOR, recolorAppIcon: true });
    dispose = startAppearanceOverride();
    runInAction(() => {
      preferences.accentColor = "#123456; } body { display: none";
    });
    expect(accentRule()).toBeUndefined();
  });
});
