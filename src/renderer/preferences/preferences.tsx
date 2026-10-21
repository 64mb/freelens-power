import { Renderer } from "@freelensapp/extensions";
import { AiPreferences } from "./ai-preferences";
import { AppearancePreferences } from "./appearance-preferences";
import { DashboardPreferences } from "./dashboard-preferences";
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
  .freelens-power-preferences { display: grid; gap: 24px; max-width: 760px; }
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

export const PowerPreferences = () => (
  <div className="freelens-power-preferences">
    <style>{styles}</style>
    <SettingsExport />
    <section aria-label="Freelens Power">
      <PowerPreferencesToggle />
    </section>
    <section aria-labelledby="freelens-power-safety-title">
      <h3 id="freelens-power-safety-title">
        <Renderer.Component.Icon material="lock_outline" size={20} /> Read-only mode
      </h3>
      <ReadOnlyPreferences />
    </section>
    <section aria-labelledby="freelens-power-appearance-title">
      <h3 id="freelens-power-appearance-title">
        <Renderer.Component.Icon material="palette" size={20} /> Appearance
      </h3>
      <AppearancePreferences />
    </section>
    <section aria-labelledby="freelens-power-monitoring-title">
      <h3 id="freelens-power-monitoring-title">
        <Renderer.Component.Icon material="show_chart" size={20} /> Monitoring
      </h3>
      <MonitoringPreferences />
    </section>
    <section aria-labelledby="freelens-power-shell-title">
      <h3 id="freelens-power-shell-title">
        <Renderer.Component.Icon material="vpn_key" size={20} /> Secure Node Shell
      </h3>
      <NodeShellPreferences />
    </section>
    <section aria-labelledby="freelens-power-ai-title">
      <h3 id="freelens-power-ai-title">
        <Renderer.Component.Icon material="chat_bubble_outline" size={20} /> AI assistant
      </h3>
      <AiPreferences />
    </section>
    <section aria-labelledby="freelens-power-dashboard-title">
      <h3 id="freelens-power-dashboard-title">
        <Renderer.Component.Icon material="dashboard" size={20} /> Dashboard
      </h3>
      <DashboardPreferences />
    </section>
  </div>
);
