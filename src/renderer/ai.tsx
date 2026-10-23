import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { autorun } from "mobx";
import { observer } from "mobx-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { AI_CHAT_CHANNEL, AI_READ_ACTIVITY_CHANNEL, type AiReadActivity } from "../common/ai";
import { AI_CANCEL_CHANNEL, attachedAiContext, normalizeAiReferences } from "../common/ai-extras";
import { expandAiShortcut } from "../common/ai-shortcuts";
import { type AiMessage, AiPreferencesStore } from "../common/store/ai-preferences-store";
import { AiShortcutsStore } from "../common/store/ai-shortcuts-store";
import { AiCopyAnswer } from "./ai-copy-answer";
import {
  AI_DIAGNOSTIC_EVENT,
  type DiagnosticFinding,
  diagnosticQuestion,
  sanitizeDiagnosticFinding,
} from "./ai-diagnostic-handoff";
import { AiContextPreview, AiResourceReferences } from "./ai-extras";
import { AiIcon } from "./ai-icon";
import { AiMessageContent } from "./ai-message";
import { AiProviderIcon } from "./ai-provider-icon";
import { AiResizeHandle, clampAiPanelWidth, DEFAULT_AI_PANEL_WIDTH } from "./ai-resize";
import { AiStarterPrompts } from "./ai-shortcuts";
import {
  type AiTerminalAttachment,
  AiTerminalContext,
  activeAiTerminal,
  captureAiTerminal,
} from "./ai-terminal-context";

export interface AiScreenContext {
  clusterId?: string;
  screen?: string;
  resource?: { kind?: string; namespace?: string; name?: string };
}

export function readAiContext(): AiScreenContext {
  const clusterId = Renderer.Catalog.activeCluster.get()?.metadata.uid;
  const screen = window.location.pathname;
  const details = new URLSearchParams(window.location.search).get("kube-details");
  const match =
    details?.match(/^\/api(?:\/v\d+)?\/namespaces\/([^/]+)\/([^/]+)\/([^/]+)$/) ??
    details?.match(/^\/apis\/[^/]+\/[^/]+\/namespaces\/([^/]+)\/([^/]+)\/([^/]+)$/);
  const clusterResource =
    details?.match(/^\/api\/[^/]+\/([^/]+)\/([^/]+)$/) ?? details?.match(/^\/apis\/[^/]+\/[^/]+\/([^/]+)\/([^/]+)$/);
  const resource = match
    ? { namespace: match[1], kind: match[2], name: match[3] }
    : clusterResource
      ? { kind: clusterResource[1], name: clusterResource[2] }
      : undefined;
  return { clusterId, screen, ...(resource ? { resource } : {}) };
}

export function isAiClusterDocument(): boolean {
  return window.top !== window && Boolean(Renderer.Catalog.activeCluster.get());
}

export function aiLauncherBottom(): number {
  const dock = document.querySelector<HTMLElement>(".Dock");
  if (!dock) return 16;
  const rect = dock.getBoundingClientRect();
  const style = window.getComputedStyle(dock);
  if (
    dock.hidden ||
    style.display === "none" ||
    style.visibility === "hidden" ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.top <= 0 ||
    rect.top >= window.innerHeight
  )
    return 16;
  return Math.max(16, window.innerHeight - rect.top + 16);
}

export function aiLauncherLeft(): number {
  const sidebar = document.querySelector<HTMLElement>('[data-testid="cluster-sidebar"], .Sidebar');
  const dock = document.querySelector<HTMLElement>(".Dock");
  let contentLeft = 0;
  for (const [element, edge] of [
    [sidebar, "right"],
    [dock, "left"],
  ] as const) {
    if (!element || element.hidden) continue;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0) continue;
    const value = rect[edge];
    if (Number.isFinite(value) && value >= 0 && value < window.innerWidth - 80)
      contentLeft = Math.max(contentLeft, value);
  }
  return contentLeft + 16;
}

export function hasAiResourceDetails(): boolean {
  if (new URLSearchParams(window.location.search).get("kube-details")) return true;
  return Array.from(
    document.querySelectorAll<HTMLElement>(".Drawer.KubeObjectDetails, .Drawer.ReleaseDetails, .DetailsDrawer"),
  ).some((element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
    );
  });
}

export function hasAiOverlay(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open], .Dialog')).some(
    (element) => {
      const style = window.getComputedStyle(element);
      return !element.hidden && style.display !== "none" && style.visibility !== "hidden";
    },
  );
}

const styles = `
@keyframes power-ai-spin { to { transform: rotate(360deg); } }
@keyframes power-ai-dot { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
body:has(.AddRemoveButtons .remove-button:not([data-freelens-power-read-only])) .power-ai-launcher { display: none; }
.power-ai-read-activity > span { display: inline-flex; align-items: center; gap: 4px; }
.power-ai-read-activity [data-status="reading"] .Icon { animation: power-ai-spin 1.2s linear infinite; }
.power-ai-thinking { margin: 12px 16px 18px; line-height: 1.5; color: var(--textColorSecondary); }
.power-ai-dots > span { animation: power-ai-dot 1.3s ease-in-out infinite; }
.power-ai-dots > span:nth-child(2) { animation-delay: .15s; }
.power-ai-dots > span:nth-child(3) { animation-delay: .3s; }
@media (prefers-reduced-motion: reduce) { .power-ai-read-activity [data-status="reading"] .Icon, .power-ai-dots > span { animation: none; } }
@keyframes power-ai-enter { from { transform: translateX(100%); } to { transform: translateX(0); } }
:root .power-ai-launcher { position: fixed; bottom: 16px; left: auto; right: 16px; z-index: 100; display: inline-flex; align-items: center; gap: 6px; min-width: 0; min-height: 0; height: 34px; border: 1px solid var(--primary, #5896ff); border-radius: 24px; padding: 0 13px; background: var(--contentColor, #242424); color: var(--textColorAccent); box-shadow: 0 3px 12px #0003; font: inherit; font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer; transition: opacity 180ms ease, background-color 140ms ease, box-shadow 140ms ease, transform 180ms ease; }
.power-ai-overview-actions { position: relative; z-index: 5; height: 0; min-height: 0; flex: 0 0 0; pointer-events: none; }
.power-ai-overview-actions + [data-testid="cluster-overview-page"] [data-monitoring-summaries] { --power-monitoring-summary-top: 56px; }
.power-ai-overview-actions button { transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease; position: absolute; top: 12px; right: 12px; pointer-events: auto; box-shadow: 0 2px 8px #0002; display: inline-flex; flex: 0 0 auto; width: auto; align-items: center; gap: 6px; min-height: 32px; padding: 6px 12px; font: inherit; font-size: 12px; border: 1px solid var(--borderFaintColor); border-radius: 10px; color: var(--textColorPrimary); background: var(--contentColor); cursor: pointer; }
.power-ai-overview-actions button:hover { border-color: var(--primary); color: var(--textColorAccent); background: var(--contentColor); }
.power-ai-overview-actions button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.power-ai-launcher.power-ai-launcher-hidden { opacity: 0; transform: translateY(8px); pointer-events: none; }
.power-ai-launcher .Icon { color: inherit; }
.power-ai-launcher:hover { background: color-mix(in srgb, var(--primary, #5896ff) 12%, var(--contentColor, #242424)); box-shadow: 0 4px 12px #0003; transform: translateY(-1px); }
.power-ai-launcher:active { transform: translateY(0); box-shadow: 0 2px 6px #0002; }
@media (prefers-reduced-motion: reduce) { :root .power-ai-launcher { transition: none; } .power-ai-launcher:hover, .power-ai-launcher:active { transform: none; } }
.power-ai-launcher:focus-visible { outline: 2px solid var(--primary, #5896ff); outline-offset: 3px; }
.power-ai-panel { position: fixed; right: 0; top: 0; bottom: 0; width: min(560px, 100vw); z-index: 10001; display: flex; flex-direction: column; background: var(--contentColor, #242424); color: var(--textColorAccent, white); animation: power-ai-enter 160ms ease-out; border-left: 1px solid var(--borderFaintColor); box-shadow: -4px 0 24px #0004; }
.power-ai-resize-handle { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; z-index: 2; cursor: col-resize; touch-action: none; }
.power-ai-resize-handle:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.power-ai-panel header { padding: 16px; display: flex; gap: 10px; flex-shrink: 0; }
.power-ai-panel header { border-bottom: 1px solid var(--borderFaintColor); justify-content: space-between; align-items: center; }
.power-ai-messages { overflow: auto; flex: 1; min-height: 0; padding: 24px 16px; font-size: var(--power-ai-font-size, 14px); line-height: 1.65; overscroll-behavior: contain; }
.power-ai-message { overflow-wrap: anywhere; padding: 14px 16px; margin-bottom: 20px; color: var(--textColorAccent); border: 1px solid var(--borderFaintColor); border-radius: 8px; }
.power-ai-panel button { padding: 7px 10px; border: 1px solid var(--borderFaintColor); border-radius: 8px; background: var(--contentColor); color: var(--textColorPrimary); cursor: pointer; }
:root .power-ai-panel header button:is(.power-ai-close, .power-ai-pin) { width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: var(--textColorSecondary); }
:root .power-ai-panel header button:is(.power-ai-close, .power-ai-pin):not(:disabled):not(.disabled):hover { color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
:root .power-ai-panel header button:is(.power-ai-close, .power-ai-pin):focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
:root .power-ai-panel button.power-ai-copy-answer { width: 24px; height: 24px; padding: 0; margin-left: auto; flex-shrink: 0; justify-content: center; border: 0; background: transparent; color: var(--textColorSecondary); }
:root .power-ai-panel button.power-ai-copy-answer:not(:disabled):not(.disabled):hover { color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
:root .power-ai-panel button.power-ai-copy-answer:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.power-ai-cancellation { display: flex; align-items: center; gap: 6px; }
:root .power-ai-panel button.power-ai-dismiss { width: 24px; height: 24px; padding: 0; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: var(--textColorSecondary); }
:root .power-ai-panel button.power-ai-dismiss:hover { color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
:root .power-ai-panel button.power-ai-dismiss:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.power-ai-panel button:disabled { opacity: 0.5; cursor: default; }
 .power-ai-panel textarea { display: block; width: 100%; box-sizing: border-box; min-width: 0; min-height: 64px; max-height: 180px; field-sizing: content; padding: 12px 16px 6px; border: 0; border-radius: 12px; background: transparent; color: var(--textColorAccent); font: inherit; font-size: var(--power-ai-font-size, 14px); line-height: 1.5; resize: none; }
.power-ai-panel textarea::placeholder { color: var(--textColorSecondary); opacity: 1; }
.power-ai-panel textarea:focus { outline: none; }
.power-ai-composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 10px 10px 16px; }
.power-ai-composer-footer > span { color: var(--textColorSecondary); font-size: 11px; line-height: 1.5; }
:root .power-ai-panel form button[type="submit"] { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 34px; width: 34px; height: 34px; padding: 0; border-radius: 10px; }
:root .power-ai-panel form button[type="submit"]:not(:disabled):not(.disabled) { background-color: var(--primary); border-color: var(--primary); color: white; }
:root .power-ai-panel form button[type="submit"]:not(:disabled):not(.disabled):hover { background-color: color-mix(in srgb, var(--primary) 88%, white 12%); border-color: color-mix(in srgb, var(--primary) 88%, white 12%); color: white; }
:root .power-ai-panel form button[type="submit"]:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
:root .power-ai-panel form button[type="submit"]:disabled { background-color: var(--contentColor); border-color: var(--borderFaintColor); color: var(--textColorSecondary); }
.power-ai-message-user { border-color: color-mix(in srgb, var(--primary) 28%, var(--borderFaintColor)); background: color-mix(in srgb, var(--primary) 7%, var(--mainBackground)); }
.power-ai-context { padding: 10px 20px; line-height: 1.5; border-bottom: 1px solid var(--borderFaintColor); font-size: 12px; color: var(--textColorSecondary); overflow-wrap: anywhere; }
.power-ai-title, .power-ai-panel button { display: inline-flex; align-items: center; gap: 6px; }
.power-ai-title { margin-right: auto; white-space: nowrap; color: var(--textColorAccent); }
.power-ai-brand { display: inline-flex; align-items: center; gap: 6px; color: var(--primary); }
.power-ai-brand .Icon { color: inherit; }
:root .power-ai-panel header button.power-ai-pin[aria-pressed="true"] { color: var(--primary); }
.power-ai-panel header > button { flex-shrink: 0; }
.power-ai-panel form { position: relative; flex-shrink: 0; margin: 0 16px 16px; border: 1px solid var(--borderFaintColor); border-radius: 12px; background: var(--mainBackground); transition: border-color 160ms ease; }
.power-ai-panel form > .power-ai-context-preview { padding: 8px 48px 4px 16px !important; min-height: 34px; margin: 0; box-sizing: border-box; }
.power-ai-context-finding { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 4px; min-width: 0; }
.power-ai-context-finding > .Icon { flex-shrink: 0; margin-top: 7px; }
.power-ai-context-finding > details { flex: 1; min-width: 0; }
.power-ai-context-finding summary { padding: 6px 0; min-height: 28px; box-sizing: border-box; cursor: pointer; overflow-wrap: anywhere; }
:root .power-ai-panel button.power-ai-remove-context { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; min-height: 28px; flex-shrink: 0; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--textColorSecondary); }
:root .power-ai-panel button.power-ai-remove-context:hover { background: color-mix(in srgb, var(--primary) 10%, transparent); color: var(--primary); }
:root .power-ai-panel button.power-ai-remove-context:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.power-ai-panel form:focus-within { border-color: var(--primary); }
.power-ai-message > strong { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 500; color: var(--textColorSecondary); margin-bottom: 10px; }
.power-ai-message-assistant { border-color: transparent; background: transparent; }
.power-ai-markdown { line-height: 1.65; font-size: var(--power-ai-font-size, 14px); color: var(--textColorAccent); }
.power-ai-markdown p { margin: 0 0 14px; white-space: pre-wrap; }
.power-ai-markdown p:last-child { margin-bottom: 0; }
.power-ai-markdown ul, .power-ai-markdown ol { padding-left: 24px; margin: 10px 0 16px; }
.power-ai-markdown ul { list-style: disc; }
.power-ai-markdown ol { list-style: decimal; }
.power-ai-markdown li { margin: 5px 0; }
.power-ai-markdown li > ul, .power-ai-markdown li > ol { margin: 6px 0; }
.power-ai-markdown li > p { margin-bottom: 6px; }
.power-ai-markdown :is(h1, h2, h3, h4, h5, h6) { color: var(--textColorAccent); font-weight: 600; line-height: 1.4; margin: 24px 0 12px; }
.power-ai-markdown :is(h1, h2, h3, h4, h5, h6):first-child { margin-top: 0; }
.power-ai-markdown h1 { font-size: 1.43em; }
.power-ai-markdown h2 { font-size: 1.29em; }
.power-ai-markdown h3 { font-size: 1.14em; }
.power-ai-markdown :is(h4, h5, h6) { font-size: 1em; }
.power-ai-markdown blockquote { margin: 16px 0; padding: 4px 14px; border-left: 3px solid var(--borderColor); color: var(--textColorSecondary); }
.power-ai-markdown blockquote > p:last-child { margin-bottom: 0; }
.power-ai-markdown table { display: block; max-width: 100%; overflow-x: auto; margin: 16px 0; border-collapse: collapse; font-size: max(10px, calc(var(--power-ai-font-size, 14px) - 1px)); }
.power-ai-markdown th, .power-ai-markdown td { padding: 9px 12px; border: 1px solid var(--borderFaintColor); text-align: left; }
.power-ai-markdown th { font-weight: 600; background: color-mix(in srgb, var(--textColorAccent) 5%, transparent); }
.power-ai-markdown a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.power-ai-markdown hr { margin: 20px 0; border: 0; border-top: 1px solid var(--borderFaintColor); }
.power-ai-markdown code { font-family: var(--font-monospace, monospace); font-size: max(10px, calc(var(--power-ai-font-size, 14px) - 1px)); background: color-mix(in srgb, var(--textColorAccent) 8%, transparent); padding: 1px 4px; border-radius: 4px; }
.power-ai-code { margin: 12px 0; border: 1px solid var(--borderFaintColor); border-radius: 8px; overflow: hidden; background: var(--mainBackground); }
.power-ai-code-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--borderFaintColor); color: var(--textColorSecondary); font-size: 11px; }
.power-ai-code-toolbar > div { display: flex; gap: 4px; }
.power-ai-code-toolbar button { padding: 4px 6px; font-size: 11px; }
.power-ai-code pre { margin: 0; padding: 12px; overflow-x: auto; white-space: pre; }
.power-ai-code pre code { padding: 0; background: transparent; }
.power-ai-code-hint, .power-ai-code-feedback:not(:empty) { padding: 0 12px 10px; color: var(--textColorSecondary); font-size: 11px; }
.power-ai-autocomplete { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; max-height: 240px; overflow-y: auto; padding: 6px; border: 1px solid var(--borderColor); border-radius: 10px; background: var(--contentColor); box-shadow: 0 4px 16px #0003; }
.power-ai-autocomplete button { display: flex; width: 100%; justify-content: space-between; gap: 12px; border: 0; text-align: left; }
.power-ai-autocomplete button[aria-selected="true"] { background: color-mix(in srgb, var(--primary) 14%, var(--contentColor)); color: var(--textColorAccent); }
.power-ai-autocomplete button > span:last-child { color: var(--textColorSecondary); font-size: 12px; }
@media (prefers-reduced-motion: reduce) { .power-ai-panel { animation: none; } }
`;

const AiChat = observer(({ isClusterDocument }: { isClusterDocument: () => boolean }) => {
  const preferences = AiPreferencesStore.getInstanceOrCreate<AiPreferencesStore>();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [launcherBottom, setLauncherBottom] = useState(aiLauncherBottom);
  const [launcherLeft, setLauncherLeft] = useState(aiLauncherLeft);
  const [resourceDetailsOpen, setResourceDetailsOpen] = useState(hasAiResourceDetails);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [launcherHidden, setLauncherHidden] = useState(false);
  const [draft, setDraft] = useState("");
  const [finding, setFinding] = useState<DiagnosticFinding>();
  const [terminalAttachment, setTerminalAttachment] = useState<AiTerminalAttachment>();
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [dismissedDraft, setDismissedDraft] = useState<string>();
  const suggestions =
    /^\/[^\s]*$/.test(draft) && dismissedDraft !== draft
      ? AiShortcutsStore.getInstanceOrCreate<AiShortcutsStore>().shortcuts.filter((shortcut) =>
          `${shortcut.command} ${shortcut.label}`.toLowerCase().includes(draft.slice(1).toLowerCase()),
        )
      : [];
  const dismissSuggestions = useRef<() => boolean>(() => false);
  dismissSuggestions.current = () => {
    if (!suggestions.length) return false;
    setDismissedDraft(draft);
    return true;
  };
  const following = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const selectSuggestion = (index: number) => {
    const shortcut = suggestions[index];
    if (!shortcut) return;
    setDraft(`/${shortcut.command} `);
    setSuggestionIndex(0);
    composer.current?.focus();
  };
  const [context, setContext] = useState(readAiContext);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState<string[]>([]);
  const activeRequests = useRef(new Map<string, string>());
  const [activity, setActivity] = useState<{
    key: string;
    reads: { method: AiReadActivity["method"]; status: "reading" | "ok" | "unavailable" }[];
  }>({ key: "", reads: [] });
  const clusterReview = useRef<() => void>(() => {});
  const messagesElement = useRef<HTMLDivElement>(null);
  const [coveredByOverlay, setCoveredByOverlay] = useState(hasAiOverlay);
  useEffect(() => {
    let observedElements: Element[] = [];
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            setLauncherBottom(aiLauncherBottom());
            setLauncherLeft(aiLauncherLeft());
          });
    const updateDock = () => {
      setViewportWidth(window.innerWidth);
      setLauncherBottom(aiLauncherBottom());
      setLauncherLeft(aiLauncherLeft());
      const elements = [
        document.querySelector(".Dock"),
        document.querySelector('[data-testid="cluster-sidebar"], .Sidebar'),
      ].filter((element): element is Element => !!element);
      if (
        elements.length !== observedElements.length ||
        elements.some((element, index) => element !== observedElements[index])
      ) {
        resizeObserver?.disconnect();
        observedElements = elements;
        for (const element of elements) resizeObserver?.observe(element);
      }
    };
    const update = () => {
      updateDock();
      const nextContext = readAiContext();
      setContext(nextContext);
      setFinding((current) => (current && current.clusterId !== nextContext.clusterId ? undefined : current));
      setResourceDetailsOpen(hasAiResourceDetails());
      setCoveredByOverlay(hasAiOverlay());
    };
    const onActivity = (_event: unknown, value: unknown) => {
      if (!value || typeof value !== "object") return;
      const entry = value as { requestId?: string; method?: string; status?: string };
      const requestKey = activeRequests.current.get(entry.requestId ?? "");
      if (
        !requestKey ||
        requestKey !== readAiContext().clusterId ||
        !["pods", "nodes", "resources", "logs"].includes(entry.method ?? "") ||
        !["reading", "ok", "unavailable"].includes(entry.status ?? "")
      )
        return;
      const read = {
        method: entry.method as AiReadActivity["method"],
        status: entry.status as "reading" | "ok" | "unavailable",
      };
      setActivity((previous) => ({
        key: requestKey,
        reads: [
          ...(previous.key === requestKey ? previous.reads.filter((item) => item.method !== read.method) : []),
          read,
        ],
      }));
    };
    ipcRenderer.on(AI_READ_ACTIVITY_CHANNEL, onActivity);
    window.addEventListener("resize", updateDock);
    window.addEventListener("popstate", update);
    update();
    const timer = window.setInterval(update, 500);
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open"],
    });
    const onDiagnostic = (event: Event) => {
      const next = sanitizeDiagnosticFinding((event as CustomEvent).detail);
      if (!next || !preferences.enabled || !isClusterDocument() || next.clusterId !== readAiContext().clusterId) return;
      update();
      setFinding(next);
      setDraft((previous) =>
        previous.trim() ? previous : "Explain this finding and suggest the next read-only checks.",
      );
      setOpen(true);
      requestAnimationFrame(() => composer.current?.focus());
    };
    window.addEventListener(AI_DIAGNOSTIC_EVENT, onDiagnostic);
    window.addEventListener("power-ai-open", updateAndOpen);
    function updateAndOpen() {
      update();
      setOpen(true);
      clusterReview.current();
    }
    return () => {
      window.removeEventListener("resize", updateDock);
      window.removeEventListener("popstate", update);
      resizeObserver?.disconnect();
      ipcRenderer.removeListener(AI_READ_ACTIVITY_CHANNEL, onActivity);
      for (const requestId of activeRequests.current.keys()) {
        void ipcRenderer.invoke(AI_CANCEL_CHANNEL, requestId).catch(() => {});
      }
      activeRequests.current.clear();
      window.clearInterval(timer);
      observer.disconnect();
      window.removeEventListener("power-ai-open", updateAndOpen);
      window.removeEventListener(AI_DIAGNOSTIC_EVENT, onDiagnostic);
    };
  }, []);
  useEffect(() => {
    setLauncherHidden(false);
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('.power-ai-panel, .Sidebar, [role="navigation"], aside'))
        return;
      if (!target.closest('.ItemListLayout, .KubeObjectListLayout, main, [role="main"]')) return;
      if (target.scrollHeight <= target.clientHeight || target.clientHeight <= 0) return;
      setLauncherHidden(target.scrollTop > 0 && target.scrollHeight - target.clientHeight - target.scrollTop <= 16);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [context.screen]);
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || hasAiOverlay()) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!dismissSuggestions.current()) setOpen(false);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [open]);
  useEffect(() => {
    if (!open || pinned) return;
    const onOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest(
          ".power-ai-panel, .power-ai-launcher, .power-ai-overview-actions, [data-freelens-power-ai-overlay]",
        )
      )
        return;
      setOpen(false);
    };
    document.addEventListener("click", onOutsideClick, true);
    return () => document.removeEventListener("click", onOutsideClick, true);
  }, [open, pinned]);
  const availablePanelWidth = Math.max(1, viewportWidth - Math.max(0, launcherLeft - 16));
  const panelWidth = clampAiPanelWidth(preferences.chatPanelWidth ?? DEFAULT_AI_PANEL_WIDTH, availablePanelWidth);
  const key = context.clusterId ?? "global";
  const messages = preferences.conversations[key] ?? [];
  const busy = pending.includes(key);
  const readActivity = activity.key === key ? activity.reads : [];
  useEffect(() => {
    const element = messagesElement.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, busy, open, key]);
  useEffect(() => {
    following.current = true;
    const element = messagesElement.current;
    if (element && open) element.scrollTop = element.scrollHeight;
  }, [open, key]);
  useEffect(() => {
    if (!terminalAttachment) return;
    const update = () => {
      if (activeAiTerminal(terminalAttachment.clusterId) !== terminalAttachment.terminalId)
        setTerminalAttachment(undefined);
    };
    update();
    const timer = window.setInterval(update, 500);
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-testid"],
    });
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
    };
  }, [terminalAttachment, context.clusterId]);
  if (!preferences.enabled || !isClusterDocument() || coveredByOverlay) return null;
  const send = async (starter?: string) => {
    const question = expandAiShortcut(
      (starter ?? draft).trim(),
      AiShortcutsStore.getInstanceOrCreate<AiShortcutsStore>().shortcuts,
    );
    if (!question || busy) return;
    if (question.length > 20_000) {
      setError("Message is too long. Please keep it under 20,000 characters.");
      return;
    }
    const activeFinding = finding?.clusterId === readAiContext().clusterId ? finding : undefined;
    const payloadQuestion = diagnosticQuestion(question, activeFinding);
    if (payloadQuestion.length > 20_000) {
      setError("Message and attached finding are too long. Shorten the message or remove the finding.");
      return;
    }
    const requestContext = attachedAiContext({
      ...readAiContext(),
      ...(activeFinding?.resource ? { resource: activeFinding.resource } : {}),
    });
    if ((requestContext.clusterId ?? "global") !== key) {
      setContext(requestContext);
      return;
    }
    const terminalSnapshot =
      terminalAttachment?.clusterId === requestContext.clusterId
        ? captureAiTerminal(requestContext.clusterId, terminalAttachment?.terminalId)
        : undefined;
    if (terminalAttachment && !terminalSnapshot) {
      setTerminalAttachment(undefined);
      setError("The attached terminal changed or is unavailable. Attach it again before sending.");
      return;
    }
    setTerminalAttachment(undefined);
    setFinding(undefined);
    following.current = true;
    const next: AiMessage[] = [...messages, { role: "user", text: question }];
    preferences.setMessages(key, next);
    setDraft("");
    setError("");
    setStopped((keys) => keys.filter((entry) => entry !== key));
    setActivity({ key, reads: [] });
    setPending((keys) => [...keys, key]);
    const provider = preferences.provider;
    const requestId = crypto.randomUUID();
    activeRequests.current.set(requestId, key);
    try {
      const response = await ipcRenderer.invoke(AI_CHAT_CHANNEL, {
        requestId,
        messages: [...next.slice(0, -1), { role: "user" as const, text: payloadQuestion }]
          .slice(-80)
          .reduceRight<AiMessage[]>((tail, message) => {
            if (tail.reduce((length, item) => length + item.text.length, 0) + message.text.length < 100_000)
              tail.unshift({ role: message.role, text: message.text });
            return tail;
          }, []),
        context: requestContext,
        ...(terminalSnapshot ? { terminalSnapshot } : {}),
        systemPrompt: [preferences.systemPrompt, requestContext.clusterId ? preferences.clusterPrompt : ""]
          .filter(Boolean)
          .join("\n\n"),
        model: preferences.model,
        speed: preferences.speed,
        reasoningEffort: preferences.reasoningEffort,
      });
      if (activeRequests.current.get(requestId) !== key) return;
      if (!response || typeof response.text !== "string") throw new Error("Invalid response");
      setActivity({
        key,
        reads: Array.isArray(response.reads)
          ? response.reads
              .filter(
                (read: AiReadActivity) =>
                  ["pods", "nodes", "resources", "logs"].includes(read?.method) &&
                  ["ok", "unavailable"].includes(read?.status),
              )
              .slice(0, 6)
          : [],
      });
      preferences.setMessages(key, [
        ...next,
        {
          role: "assistant",
          text: response.text,
          provider: response.provider === "claude" ? "claude" : provider,
          references: normalizeAiReferences(response.references),
        },
      ]);
    } catch (failure) {
      if (activeRequests.current.get(requestId) !== key) return;
      const code = String(failure).match(/FREELENS_AI_([A-Z_]+)/)?.[1];
      const messages: Record<string, string> = {
        READ_LIMIT: "The assistant reached the read limit. Try a more specific question.",
        TIMEOUT: "The request timed out. Please try again.",
        INVALID_REPLY: "The assistant returned an incomplete reply. Please try again.",
        CLI_FAILURE: "The selected CLI request failed. Check your model access or try again.",
        CANCELLED: "The request was canceled.",
        UNSAFE_POLICY:
          "Claude managed policy cannot be safely isolated. Use Codex or ask your administrator to disable managed hooks and command helpers.",
        INPUT_LIMIT: "The request is too large. Start a new chat or shorten the message.",
      };
      setError(
        (code && messages[code]) ||
          "Unable to complete the request. Check that the selected CLI is installed and signed in, then try again.",
      );
    } finally {
      activeRequests.current.delete(requestId);
      setPending((keys) => keys.filter((entry) => entry !== key));
    }
  };
  const stopResponse = () => {
    const requestId = [...activeRequests.current].find(([, requestKey]) => requestKey === key)?.[0];
    if (!requestId) return;
    activeRequests.current.delete(requestId);
    setStopped((keys) => [...keys.filter((entry) => entry !== key), key]);
    setActivity({ key, reads: [] });
    setError("");
    void ipcRenderer.invoke(AI_CANCEL_CHANNEL, requestId).catch(() => {});
  };
  clusterReview.current = () => {
    const currentKey = readAiContext().clusterId;
    if (!currentKey || currentKey !== key || preferences.conversations[currentKey]?.length) return;
    void send(
      preferences.clusterPrompt.trim() ||
        "Review this cluster using read-only queries and summarize its health and useful next steps.",
    );
  };
  return (
    <>
      <style>{styles}</style>
      {!open && (
        <button
          type="button"
          className={`power-ai-launcher${launcherHidden ? " power-ai-launcher-hidden" : ""}`}
          aria-hidden={launcherHidden || undefined}
          tabIndex={launcherHidden ? -1 : 0}
          style={{
            bottom: launcherBottom,
            left: resourceDetailsOpen ? launcherLeft : "auto",
            right: resourceDetailsOpen ? "auto" : 16,
          }}
          onClick={() => setOpen(true)}
          aria-label="Open AI assistant"
          title="Open AI assistant"
        >
          <span aria-hidden="true">
            <AiIcon material="chat_bubble_outline" size={16} />
          </span>{" "}
          AI
        </button>
      )}
      {open && (
        <aside
          className="power-ai-panel"
          aria-label="AI assistant"
          style={{ "--power-ai-font-size": `${preferences.chatFontSize ?? 14}px`, width: panelWidth } as CSSProperties}
        >
          <AiResizeHandle
            width={panelWidth}
            available={availablePanelWidth}
            onChange={(width) => preferences.setChatPanelWidth(width)}
          />
          <header>
            <strong className="power-ai-title">
              <span className="power-ai-brand" title="AI assistant">
                <AiIcon material="auto_awesome" size={18} /> AI
              </span>{" "}
              Assistant
            </strong>
            <button
              type="button"
              disabled={busy}
              aria-label="New chat"
              title="Clear this conversation and start a new chat"
              onClick={() => {
                setTerminalAttachment(undefined);
                setFinding(undefined);
                preferences.setMessages(key, []);
                setStopped((keys) => keys.filter((entry) => entry !== key));
                setActivity({ key, reads: [] });
                setError("");
              }}
            >
              <AiIcon material="add_comment" size={16} /> New chat
            </button>
            <button
              type="button"
              className="power-ai-pin"
              aria-label="Pin AI assistant"
              aria-pressed={pinned}
              title={pinned ? "Unpin to close when clicking outside" : "Pin to keep the assistant open"}
              onClick={() => setPinned((value) => !value)}
            >
              <AiIcon material="push_pin" size={18} />
            </button>
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
              }}
              className="power-ai-close"
              aria-label="Close AI assistant"
              title="Close AI assistant"
            >
              <span aria-hidden="true">
                <AiIcon material="close" size={18} />
              </span>
            </button>
          </header>
          <div className="power-ai-context">
            {context.clusterId ? "Cluster conversation" : "General conversation"} · {context.screen}
            {context.resource && ` · ${context.resource.kind}/${context.resource.name}`}
            <br />
            Only screen and resource metadata are attached automatically.
          </div>
          <div
            className="power-ai-messages"
            onScroll={(event) => {
              const element = event.currentTarget;
              following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            }}
            aria-live="polite"
            ref={messagesElement}
          >
            {messages.length === 0 && (
              <div className="power-ai-starters">
                <p style={{ marginBottom: 12 }}>Ask about this screen or your cluster:</p>
                <AiStarterPrompts
                  disabled={busy}
                  onSelect={(prompt) => {
                    void send(prompt);
                  }}
                />
              </div>
            )}
            {messages.map((message, index) => (
              <div className={`power-ai-message power-ai-message-${message.role}`} key={index}>
                <strong>
                  {message.role === "user" ? (
                    <span title="You">
                      <AiIcon material="person_outline" size={16} />
                    </span>
                  ) : (
                    <AiProviderIcon provider={message.provider === "claude" ? "claude" : "codex"} />
                  )}
                  {message.role === "user" ? "You" : message.provider === "claude" ? "Claude" : "Codex"}
                  {message.role === "assistant" && <AiCopyAnswer text={message.text} />}
                </strong>
                <AiMessageContent text={message.text} />
                {message.role === "assistant" && context.clusterId && (
                  <AiResourceReferences
                    clusterId={context.clusterId}
                    references={message.references}
                    text={message.text}
                    onOpened={() => setOpen(false)}
                  />
                )}
              </div>
            ))}
            {readActivity.length > 0 && (
              <div
                className="power-ai-read-activity"
                style={{ fontSize: 11, color: "var(--textColorSecondary)", margin: "8px 16px" }}
              >
                {readActivity.map((read, index) => (
                  <span
                    key={index}
                    title={`${read.method} · ${read.status === "reading" ? "reading" : read.status === "ok" ? "read" : "unavailable"}`}
                    data-method={read.method}
                    data-status={read.status}
                    style={{ marginRight: 10 }}
                  >
                    <AiIcon
                      material={
                        read.status === "reading"
                          ? "sync"
                          : read.status === "ok"
                            ? "check_circle_outline"
                            : "info_outline"
                      }
                      size={13}
                    />{" "}
                    {read.method} ·{" "}
                    {read.status === "reading" ? "reading" : read.status === "ok" ? "read" : "unavailable"}
                  </span>
                ))}
              </div>
            )}
            {busy && (
              <p className="power-ai-thinking" role="status">
                {stopped.includes(key) ? "Stopping response" : "Thinking"}
                <span className="power-ai-dots" aria-hidden="true">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </p>
            )}
            {!busy && stopped.includes(key) && (
              <p className="power-ai-cancellation" role="status">
                Response stopped{" "}
                <button
                  type="button"
                  aria-label="Dismiss cancellation"
                  className="power-ai-dismiss"
                  title="Dismiss"
                  onClick={() => setStopped((keys) => keys.filter((entry) => entry !== key))}
                >
                  <AiIcon material="close" size={14} />
                </button>
              </p>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {suggestions.length > 0 && (
              <div
                className="power-ai-autocomplete"
                role="listbox"
                id="power-ai-commands"
                aria-label="Prompt shortcuts"
              >
                {suggestions.map((shortcut, index) => (
                  <button
                    type="button"
                    role="option"
                    id={`power-ai-command-${index}`}
                    aria-selected={index === suggestionIndex % suggestions.length}
                    key={shortcut.id}
                    title={`Insert /${shortcut.command}: ${shortcut.label}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectSuggestion(index)}
                  >
                    <span>/{shortcut.command}</span>
                    <span>{shortcut.label}</span>
                  </button>
                ))}
              </div>
            )}
            <AiContextPreview
              finding={finding?.clusterId === context.clusterId ? finding : undefined}
              onRemoveFinding={() => setFinding(undefined)}
              context={attachedAiContext({
                ...context,
                ...(finding && finding.clusterId === context.clusterId && finding.resource
                  ? { resource: finding.resource }
                  : {}),
              })}
            />
            <AiTerminalContext
              clusterId={context.clusterId}
              attachment={terminalAttachment}
              onChange={setTerminalAttachment}
              disabled={busy}
            />
            <textarea
              ref={composer}
              aria-controls={suggestions.length ? "power-ai-commands" : undefined}
              aria-expanded={suggestions.length > 0}
              aria-activedescendant={
                suggestions.length ? `power-ai-command-${suggestionIndex % suggestions.length}` : undefined
              }
              autoFocus
              aria-label="Message"
              placeholder="Ask about this cluster…"
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (suggestions.length && !event.shiftKey) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setSuggestionIndex(
                      (index) =>
                        (index + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length,
                    );
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    selectSuggestion(suggestionIndex % suggestions.length);
                    return;
                  }
                }
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  if (!busy) void send();
                }
              }}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSuggestionIndex(0);
                setDismissedDraft(undefined);
              }}
              disabled={busy}
            />
            <div className="power-ai-composer-footer">
              <span>Enter to send · Shift+Enter for newline</span>
              {busy ? (
                <button
                  type="button"
                  aria-label="Stop response"
                  disabled={stopped.includes(key)}
                  onClick={stopResponse}
                >
                  <AiIcon material="stop" size={16} /> Stop
                </button>
              ) : (
                <button type="submit" disabled={!draft.trim()} aria-label="Send">
                  <AiIcon material="send" size={16} />
                </button>
              )}
            </div>
          </form>
        </aside>
      )}
    </>
  );
});

export function startAiChat(isClusterDocument: () => boolean = isAiClusterDocument): () => void {
  const container = document.createElement("div");
  container.dataset.freelensPowerAi = "";
  document.body.append(container);
  let mounted = false;
  let overviewActions: HTMLDivElement | undefined;
  let overviewIcon: HTMLSpanElement | undefined;
  let overviewLabel: HTMLSpanElement | undefined;
  let overviewResize: ResizeObserver | undefined;
  const updateOverviewLabel = () => {
    const overview = overviewActions?.nextElementSibling;
    const compact = Boolean(overview?.querySelector("[data-freelens-power-monitoring]") && overview.clientWidth > 960);
    const label = compact ? "Ask AI" : "Ask about cluster";
    if (overviewLabel && overviewLabel.textContent !== label) overviewLabel.textContent = label;
    overviewActions?.querySelector("button")?.setAttribute("aria-label", compact ? "Ask AI about cluster" : label);
  };
  const removeOverview = () => {
    overviewResize?.disconnect();
    overviewResize = undefined;
    if (overviewIcon) ReactDOM.unmountComponentAtNode(overviewIcon);
    overviewIcon = undefined;
    overviewLabel = undefined;
    overviewActions?.remove();
    overviewActions = undefined;
  };
  const preferences = AiPreferencesStore.getInstanceOrCreate<AiPreferencesStore>();
  const reconcile = () => {
    const overview =
      preferences.enabled &&
      isClusterDocument() &&
      Renderer.Catalog.activeCluster.get() &&
      document.querySelector('[data-testid="cluster-overview-page"]');
    if (!overview) {
      removeOverview();
      return;
    }
    if (overviewActions?.isConnected && overviewActions.nextElementSibling === overview) {
      updateOverviewLabel();
      return;
    }
    removeOverview();
    overviewActions = document.createElement("div");
    overviewActions.className = "power-ai-overview-actions";
    const overviewButton = document.createElement("button");
    overviewButton.type = "button";
    overviewButton.setAttribute("aria-label", "Ask about cluster");
    overviewButton.title = "Open the AI assistant to ask about this cluster";
    overviewIcon = document.createElement("span");
    overviewIcon.setAttribute("aria-hidden", "true");
    overviewLabel = document.createElement("span");
    overviewButton.append(overviewIcon, overviewLabel);
    overviewButton.onclick = () => window.dispatchEvent(new Event("power-ai-open"));
    overviewActions.append(overviewButton);
    overview.before(overviewActions);
    updateOverviewLabel();
    if (typeof ResizeObserver !== "undefined") {
      overviewResize = new ResizeObserver(updateOverviewLabel);
      overviewResize.observe(overview);
    }
    ReactDOM.render(<AiIcon material="auto_awesome" size={16} />, overviewIcon);
  };
  const observer = new MutationObserver(reconcile);
  const stop = autorun(() => {
    if (preferences.enabled && !mounted) {
      observer.observe(document.body, { childList: true, subtree: true });
      mounted = true;
      ReactDOM.render(<AiChat isClusterDocument={isClusterDocument} />, container);
    } else if (!preferences.enabled && mounted) {
      observer.disconnect();
      ReactDOM.unmountComponentAtNode(container);
      mounted = false;
    }
    reconcile();
  });
  return () => {
    stop();
    observer.disconnect();
    removeOverview();
    ReactDOM.unmountComponentAtNode(container);
    container.remove();
  };
}
