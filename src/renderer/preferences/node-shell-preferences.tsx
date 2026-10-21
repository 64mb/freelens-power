import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { NodeShellPreferencesStore } from "../../common/store/node-shell-preferences-store";

const { Input, Switch } = Renderer.Component;

export const NodeShellPreferences = observer(() => {
  const preferences = NodeShellPreferencesStore.getInstanceOrCreate<NodeShellPreferencesStore>();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div
          className="power-settings-row"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}
        >
          <label htmlFor="freelens-power-node-shell-command">Connection command</label>
          <div style={{ width: 220, maxWidth: "100%", flexShrink: 0 }}>
            <Input
              id="freelens-power-node-shell-command"
              placeholder="ssh"
              value={preferences.command}
              onChange={(value) => {
                preferences.command = value;
              }}
            />
          </div>
        </div>
        <div className="power-settings-hint" style={{ marginTop: 14 }}>
          Command and arguments for the local terminal. Defaults to ssh.
        </div>
      </div>
      <div>
        <Switch
          checked={preferences.preferIPv6}
          onChange={(value) => {
            preferences.preferIPv6 = value;
          }}
        >
          Prefer IPv6
        </Switch>
        <div className="power-settings-hint">Use IPv6 when available, otherwise fall back to IPv4.</div>
      </div>
      <div>
        <Switch
          checked={preferences.useColimaSSH}
          onChange={(value) => {
            preferences.useColimaSSH = value;
          }}
        >
          Use Colima SSH
        </Switch>
        <div className="power-settings-hint">Use colima ssh for the local Colima node.</div>
      </div>
    </div>
  );
});
