import { Renderer } from "@freelensapp/extensions";
import { EXTENSION_ID } from "../../common/extension-info";
import { AiPreferences } from "./ai-preferences";
import { AppearancePreferences } from "./appearance-preferences";
import { DashboardPreferences } from "./dashboard-preferences";
import { LogsPreferences } from "./logs-preferences";
import { MonitoringPreferences } from "./monitoring-preferences";
import { NodeShellPreferences } from "./node-shell-preferences";
import { PowerPreferencesToggle } from "./power-preferences";
import { ReadOnlyPreferences } from "./read-only-preferences";
import { SettingsExport } from "./settings-export";

const styles = `
  .power-preferences-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .power-preferences-header-actions { display: inline-flex; margin-left: auto; flex-shrink: 0; }
  #freelens-power-settings > .SubTitle,
  #freelens-power-settings > .hint,
  #freelens-power-settings + hr { display: none; }
  .freelens-power-preferences { display: grid; gap: 24px; max-width: 760px; container: power-preferences / inline-size; }
  .freelens-power-preferences .power-preferences-section-links {
    display:flex; align-items:center; width:100%; gap:8px; overflow-x:auto;
  }
  :root .freelens-power-preferences .power-preferences-section-links button.power-settings-section-link {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    flex:1 0 auto; width:auto; min-width:max-content; min-height:32px; padding:4px 2px;
    border: 0; border-radius: 4px; background: transparent; box-shadow: none;
    color: var(--textColorSecondary); text-transform: none; white-space: nowrap; cursor: pointer;
  }
  :root .freelens-power-preferences .power-preferences-section-links button.power-settings-section-link:hover {
    color: var(--primary); background: transparent; box-shadow: none;
  }
  :root .freelens-power-preferences .power-preferences-section-links button.power-settings-section-link::before {
    content: none;
  }
  :root .freelens-power-preferences .power-preferences-section-links button.power-settings-section-link:focus-visible {
    color: var(--primary); background: transparent; box-shadow: none;
    outline: 2px solid var(--primary); outline-offset: 2px;
  }
  @container power-preferences (max-width:660px) { .power-preferences-section-links { font-size:12px; } }
  .freelens-power-preferences section[id] { scroll-margin-top: 16px; }
  .freelens-power-preferences section {
    padding: 24px; border: 1px solid var(--borderFaintColor);
    border-radius: 12px; background: var(--contentColor);
  }
  .freelens-power-preferences button, .freelens-power-preferences .Button { transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease; }
  :root .freelens-power-preferences button.power-settings-icon-action,
  :root .power-preferences-header-actions button.power-settings-icon-action {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; min-width: 32px; padding: 0; flex-shrink: 0;
    border: 0; border-radius: 6px; background: transparent; color: var(--textColorSecondary); cursor: pointer;
    transition: color 160ms ease, background-color 160ms ease;
  }
  :root .freelens-power-preferences button.power-settings-icon-action:not(:disabled):hover,
  :root .power-preferences-header-actions button.power-settings-icon-action:not(:disabled):hover {
    color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent);
  }
  :root .freelens-power-preferences button.power-settings-icon-action:focus-visible,
  :root .power-preferences-header-actions button.power-settings-icon-action:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  :root .freelens-power-preferences button.power-settings-icon-action:disabled,
  :root .power-preferences-header-actions button.power-settings-icon-action:disabled { opacity: 0.4; cursor: default; }
  .freelens-power-preferences h3 {
    display: flex; align-items: center; gap: 10px; margin: 0 0 24px; font-size: 16px; font-weight: 600; color: var(--textColorAccent);
  }
  .freelens-power-preferences label[data-testid="switch"] {
    display: flex; width: 100%; align-items: center; justify-content: space-between;
  }
  .freelens-power-preferences .power-settings-hint {
    margin-top: 6px; font-size: 12px; line-height: 1.5; color: var(--textColorSecondary);
  }
  @media (max-width: 760px) {
    .freelens-power-preferences section { padding: 18px; }
    .freelens-power-preferences .power-settings-row { flex-wrap: wrap; }
  }
`;

const sectionLinks = [
  { id: "safety", title: "Safety", icon: "lock_outline" },
  { id: "appearance", title: "Appearance", icon: "palette" },
  { id: "monitoring", title: "Monitoring", icon: "show_chart" },
  { id: "logs", title: "Logs", icon: "subject" },
  { id: "shell", title: "Shell", icon: "vpn_key" },
  { id: "ai", title: "AI", icon: "chat_bubble_outline" },
  { id: "dashboard", title: "Dashboard", icon: "dashboard" },
];

export const PowerPreferences = () => (
  <div className="freelens-power-preferences">
    <style>{styles}</style>
    <SettingsExport />
    <section aria-label="Freelens Power">
      <PowerPreferencesToggle />
    </section>
    <nav className="power-preferences-section-links" aria-label="Settings sections">
      {sectionLinks.map(({ id, title, icon }) => (
        <Renderer.Component.Button
          key={id}
          className="power-settings-section-link"
          aria-label={title}
          title={`Jump to ${title} settings`}
          onClick={(event) => {
            event.preventDefault();
            const section = document.getElementById(`freelens-power-${id}-section`);
            requestAnimationFrame(() => {
              if (!section?.isConnected) return;
              section.focus({ preventScroll: true });
              section.scrollIntoView({ block: "start", behavior: "instant" });
            });
          }}
        >
          <Renderer.Component.Icon material={icon} size={16} /> {title}
        </Renderer.Component.Button>
      ))}
    </nav>
    <section id="freelens-power-safety-section" tabIndex={-1} aria-labelledby="freelens-power-safety-title">
      <h3 id="freelens-power-safety-title">
        <Renderer.Component.Icon material="lock_outline" size={20} /> Read-only mode
      </h3>
      <ReadOnlyPreferences />
    </section>
    <section id="freelens-power-appearance-section" tabIndex={-1} aria-labelledby="freelens-power-appearance-title">
      <h3 id="freelens-power-appearance-title">
        <Renderer.Component.Icon material="palette" size={20} /> Appearance
      </h3>
      <AppearancePreferences />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
        <Renderer.Component.Button
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          onClick={() => Renderer.Navigation.navigate(`/extension/${EXTENSION_ID}/cluster-icons`)}
          title="Create matching icons for your saved clusters"
        >
          <Renderer.Component.Icon material="palette" size={16} /> Cluster icons
        </Renderer.Component.Button>
      </div>
    </section>
    <section id="freelens-power-monitoring-section" tabIndex={-1} aria-labelledby="freelens-power-monitoring-title">
      <h3 id="freelens-power-monitoring-title">
        <Renderer.Component.Icon material="show_chart" size={20} /> Monitoring
      </h3>
      <MonitoringPreferences />
    </section>
    <section id="freelens-power-logs-section" tabIndex={-1} aria-labelledby="freelens-power-logs-title">
      <h3 id="freelens-power-logs-title">
        <Renderer.Component.Icon material="subject" size={20} /> Power Logs
      </h3>
      <LogsPreferences />
    </section>
    <section id="freelens-power-shell-section" tabIndex={-1} aria-labelledby="freelens-power-shell-title">
      <h3 id="freelens-power-shell-title">
        <Renderer.Component.Icon material="vpn_key" size={20} /> Secure Node Shell
      </h3>
      <NodeShellPreferences />
    </section>
    <section id="freelens-power-ai-section" tabIndex={-1} aria-labelledby="freelens-power-ai-title">
      <h3 id="freelens-power-ai-title">
        <Renderer.Component.Icon material="chat_bubble_outline" size={20} /> AI assistant
      </h3>
      <AiPreferences />
    </section>
    <section id="freelens-power-dashboard-section" tabIndex={-1} aria-labelledby="freelens-power-dashboard-title">
      <h3 id="freelens-power-dashboard-title">
        <Renderer.Component.Icon material="dashboard" size={20} /> Dashboard
      </h3>
      <DashboardPreferences />
    </section>
  </div>
);
