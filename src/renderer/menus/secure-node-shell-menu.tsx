import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { buildNodeShellCommand, isColimaNode, selectNodeAddress } from "../../common/node-shell";
import { NodeShellPreferencesStore } from "../../common/store/node-shell-preferences-store";

const { MenuItem, Icon, Notifications, createTerminalTab, terminalStore } = Renderer.Component;

export const SecureNodeShellMenu = observer(
  ({ object: node, toolbar }: Renderer.Component.KubeObjectMenuProps<Renderer.K8sApi.Node>) => {
    const preferences = NodeShellPreferencesStore.getInstanceOrCreate<NodeShellPreferencesStore>();
    const address = selectNodeAddress(node.status?.addresses ?? [], preferences.preferIPv6);

    const useColimaSSH =
      preferences.useColimaSSH &&
      isColimaNode(
        Renderer.Catalog.activeCluster.get()?.spec.kubeconfigContext,
        node.getName(),
        node.metadata.labels?.["kubernetes.io/hostname"],
      );
    const canConnect = useColimaSSH || Boolean(address);

    const connect = async () => {
      if (!canConnect) return;

      try {
        const command = useColimaSSH ? "colima ssh" : buildNodeShellCommand(preferences.command, address!);
        const tab = createTerminalTab({ title: `Secure Node Shell: ${node.getName()}` });
        await terminalStore.sendCommand(command, { enter: true, tabId: tab.id });
        Renderer.Navigation.hideDetails();
      } catch {
        Notifications.error("Unable to open Secure Node Shell");
      }
    };

    return (
      <MenuItem className="power-secure-node-shell-menu" onClick={connect} disabled={!canConnect} style={{ order: -1 }}>
        <Icon
          {...(preferences.replaceDefaultNodeShell ? { svg: "ssh" } : { material: "vpn_key" })}
          interactive={toolbar}
          tooltip={canConnect ? "Secure Node Shell" : "No node IP address available"}
        />
        <span className="title">Secure Node Shell</span>
      </MenuItem>
    );
  },
);
