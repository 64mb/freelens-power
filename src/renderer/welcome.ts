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

  const labels = [
    "🔐 Secure Node Shell with IPv6 and Colima",
    "📜 Certificate details in Secrets",
    "🎨 Themes and cluster icon studio",
    "🔗 Website cards with pinning and refresh",
    "📈 CPU/RAM metrics with local history",
    "🔎 Resource usage, timelines and Pending",
    "🤖 AI chat with context and read-only tools",
    "🔒 Read-only controls for Kubernetes",
  ];
  for (const [index, text] of [
    "🔐 Secure Node Shell with custom commands, IPv6 and automatic Colima support",
    "📜 Certificate details in Secrets",
    "🎨 Accent themes and matching custom cluster icons",
    "🔗 Website dashboards with flexible cards, pinned windows and background refresh",
    "📈 Cluster, node and pod metrics with optional local history",
    "🔎 Resource consumers, application timelines and Pending diagnostics",
    "🤖 Context-aware AI chat with read-only tools and prompt shortcuts",
    "🔒 Read-only UI controls for safer browsing",
  ].entries()) {
    const feature = document.createElement("li");
    feature.setAttribute("role", "listitem");
    feature.textContent = labels[index];
    feature.title = text;
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
    .Welcome [${CONTENT_ATTRIBUTE}] .freelens-power-features { display: grid; grid-template-columns: repeat(2, minmax(0, max-content)); justify-content: center; gap: 14px 48px; list-style: none; padding: 16px 0; margin: 16px 0; border-top: 1px solid var(--borderColor); border-bottom: 1px solid var(--borderColor); text-align: left; line-height: 1.5; }
    .Welcome [${CONTENT_ATTRIBUTE}] .freelens-power-features > li, .Welcome [${CONTENT_ATTRIBUTE}] .freelens-power-features > li:hover { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 0; padding: 0; background: none; border: 0; border-radius: 0; box-shadow: none; cursor: default; color: inherit; text-decoration: none; transform: none; transition: none; }
    .Welcome [data-testid="welcome-banner-container"]:has([${HOST_ATTRIBUTE}]) { width: min(960px, calc(100% - 48px)) !important; }
    .Welcome [${HOST_ATTRIBUTE}] { width: 100% !important; max-width: 100%; }
    .Welcome [data-testid="no-welcome-banners-icon"] { display: inline-flex; width: 120px; height: 120px; }
    .Welcome [data-testid="no-welcome-banners-icon"] svg { width: 100%; height: 100%; }
    .Welcome [${HOST_ATTRIBUTE}] [data-testid="welcome-menu-container"] { width: fit-content !important; margin-inline: auto; max-width: 100%; }
    .Welcome [${HOST_ATTRIBUTE}] [data-testid="welcome-menu-container"] > li { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
    .Welcome [${HOST_ATTRIBUTE}] [data-testid="welcome-menu-container"] .box { flex: 0 0 auto; width: auto; padding: 0; }
    .Welcome [${HOST_ATTRIBUTE}] [data-testid="welcome-menu-container"] a { margin-left: 0; }
    @media (max-width: 640px) {
      .Welcome [${CONTENT_ATTRIBUTE}] .freelens-power-features { grid-template-columns: 1fr; }
    }
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
