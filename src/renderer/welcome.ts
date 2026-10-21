// SPDX-License-Identifier: Apache-2.0

const WELCOME_SELECTOR = '.Welcome [data-testid="welcome-text-container"]';
const HOST_ATTRIBUTE = "data-freelens-power-welcome";
const CONTENT_ATTRIBUTE = "data-freelens-power-welcome-content";

function createWelcomeContent(): HTMLDivElement {
  const content = document.createElement("div");
  content.setAttribute(CONTENT_ATTRIBUTE, "");

  const heading = document.createElement("h2");
  heading.textContent = "🔋 Freelens Power";
  content.append(heading);

  const introduction = document.createElement("p");
  introduction.textContent = "Make Freelens your own with practical tools for everyday Kubernetes work.";
  content.append(introduction);

  const features = document.createElement("ul");
  features.className = "freelens-power-features";
  features.setAttribute("role", "list");

  for (const text of [
    "🔐 Secure Node Shell with custom commands, IPv6 and automatic Colima support",
    "📜 Certificate details in Secrets",
    "🎨 Accent themes for Freelens",
    "🔗 Website dashboards with flexible cards and background refresh",
    "🤖 Context-aware AI chat with read-only tools and prompt shortcuts",
    "🔒 Read-only UI controls for safer browsing",
  ]) {
    const feature = document.createElement("li");
    feature.setAttribute("role", "listitem");
    feature.textContent = text;
    features.append(feature);
  }

  content.append(features);

  const paragraph = document.createElement("p");
  const link = document.createElement("a");
  link.className = "link";
  link.href = "https://github.com/64mb/freelens-power";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Freelens Power on GitHub";
  paragraph.append(link);
  content.append(paragraph);

  return content;
}

export function startWelcomeOverride(): () => void {
  const style = document.createElement("style");
  style.setAttribute("data-freelens-power", "welcome");
  style.textContent = `
    .Welcome [${HOST_ATTRIBUTE}] > h2,
    .Welcome [${HOST_ATTRIBUTE}] > p { display: none; }
    .Welcome [${CONTENT_ATTRIBUTE}] { color: var(--textColorSecondary); }
    .Welcome [${CONTENT_ATTRIBUTE}] h2 { color: var(--textColorPrimary); margin: 15px 0 16px; }
    .Welcome [${CONTENT_ATTRIBUTE}] .freelens-power-features { display: flex; flex-direction: column; gap: 12px; list-style: none; padding: 16px 0; margin: 16px 0; border-top: 1px solid var(--borderColor); border-bottom: 1px solid var(--borderColor); text-align: left; line-height: 1.5; }
    .Welcome [${CONTENT_ATTRIBUTE}] .freelens-power-features > li, .Welcome [${CONTENT_ATTRIBUTE}] .freelens-power-features > li:hover { margin: 0; padding: 0; background: none; border: 0; border-radius: 0; box-shadow: none; cursor: default; color: inherit; text-decoration: none; transform: none; transition: none; }
    .Welcome [${CONTENT_ATTRIBUTE}] p { margin-top: 14px; }
  `;
  document.head.append(style);

  const hosts = new Map<Element, { content: HTMLDivElement; previousAttribute: string | null }>();

  const restore = (host: Element) => {
    const entry = hosts.get(host);
    if (!entry) return;

    entry.content.remove();
    if (entry.previousAttribute === null) {
      host.removeAttribute(HOST_ATTRIBUTE);
    } else {
      host.setAttribute(HOST_ATTRIBUTE, entry.previousAttribute);
    }
    hosts.delete(host);
  };

  const attach = (host: Element) => {
    if (hosts.has(host)) return;

    const content = createWelcomeContent();
    hosts.set(host, { content, previousAttribute: host.getAttribute(HOST_ATTRIBUTE) });
    host.setAttribute(HOST_ATTRIBUTE, "");
    host.prepend(content);
  };

  const scan = (node: Element) => {
    if (node.matches(WELCOME_SELECTOR)) attach(node);
    for (const host of node.querySelectorAll(WELCOME_SELECTOR)) attach(host);
  };

  scan(document.body);

  const observer = new MutationObserver((mutations) => {
    for (const host of hosts.keys()) {
      if (!host.isConnected) restore(host);
    }

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element && node.isConnected) scan(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    for (const host of hosts.keys()) restore(host);
    style.remove();
  };
}
