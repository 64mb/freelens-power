// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWelcomeOverride } from "./welcome";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mountWelcome(): HTMLElement {
  const page = document.createElement("div");
  page.className = "Welcome";
  page.innerHTML = `<div data-testid="welcome-text-container"><h2 class="original">Welcome to Freelens!</h2><p style="color: red">Original description <a href="https://example.com">Forum</a></p><ul><li><button>Browse clusters</button></li></ul></div>`;
  document.body.append(page);
  return page.firstElementChild as HTMLElement;
}

const customContent = (host: Element) => host.querySelector("[data-freelens-power-welcome-content]");

async function flushMutations() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("welcome content override", () => {
  it("adds concise features and a fixed GitHub link while keeping the host navigation", () => {
    const host = mountWelcome();
    const button = host.querySelector("button") as HTMLButtonElement;
    const onClick = vi.fn();
    button.addEventListener("click", onClick);
    dispose = startWelcomeOverride();

    const content = customContent(host);
    expect(content?.querySelector("h2")?.textContent).toBe("🔋 Freelens Power");
    expect(content?.querySelector("p")?.textContent).toBe(
      "Make Freelens your own with practical tools for everyday Kubernetes work.",
    );
    expect(content?.querySelectorAll('[role="listitem"]')).toHaveLength(8);
    expect(content?.querySelector("ul")?.children).toHaveLength(8);
    expect(Array.from(content?.querySelectorAll("li") ?? [], (item) => item.textContent?.split(" ")[0])).toEqual([
      "🔐",
      "📜",
      "🎨",
      "🔗",
      "📈",
      "🔎",
      "🤖",
      "🔒",
    ]);
    expect(content?.textContent).toContain("IPv6 and Colima");
    expect(content?.querySelector("li")?.title).toContain("IPv6 and automatic Colima");
    expect(content?.textContent).toContain("Certificate details in Secrets");
    expect(content?.textContent).toContain("Themes and cluster icon studio");
    expect(content?.textContent).not.toContain("macOS");
    expect(content?.textContent).not.toContain("Dock icon");
    const link = content?.querySelector("a");
    expect(link?.href).toBe("https://github.com/64mb/freelens-power");
    expect(link?.className).toBe("link");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(host.querySelector("button")).toBe(button);
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(getComputedStyle(host.querySelector("h2.original") as Element).display).toBe("none");
  });

  it("handles late mounting and navigation without duplicating content", async () => {
    dispose = startWelcomeOverride();
    const first = mountWelcome();
    await flushMutations();
    expect(customContent(first)).not.toBeNull();
    first.append(document.createElement("span"));
    await flushMutations();
    expect(first.querySelectorAll("[data-freelens-power-welcome-content]")).toHaveLength(1);

    first.parentElement?.remove();
    await flushMutations();
    expect(customContent(first)).toBeNull();
    expect(first.hasAttribute("data-freelens-power-welcome")).toBe(false);
    const next = mountWelcome();
    await flushMutations();
    expect(customContent(next)).not.toBeNull();
  });

  it("restores exact original markup, attributes and node identities on cleanup", async () => {
    const host = mountWelcome();
    host.setAttribute("data-freelens-power-welcome", "previous");
    const originalMarkup = host.outerHTML;
    const heading = host.firstElementChild;
    const paragraph = heading?.nextElementSibling;
    dispose = startWelcomeOverride();
    await flushMutations();
    dispose();
    dispose = undefined;

    expect(host.outerHTML).toBe(originalMarkup);
    expect(host.firstElementChild).toBe(heading);
    expect(heading?.nextElementSibling).toBe(paragraph);
    expect(getComputedStyle(heading as Element).display).not.toBe("none");
    expect(document.querySelector('style[data-freelens-power="welcome"]')).toBeNull();

    const later = mountWelcome();
    await flushMutations();
    expect(customContent(later)).toBeNull();
  });
});
