/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See THIRD_PARTY_LICENSES for more information.
 */

import { Common, Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { observer } from "mobx-react";
import { EXTENSION_DISPLAY_NAME, EXTENSION_ID } from "../common/extension-info";
import { AiPreferencesStore } from "../common/store/ai-preferences-store";
import { AiShortcutsStore } from "../common/store/ai-shortcuts-store";
import { AppearancePreferencesStore } from "../common/store/appearance-preferences-store";
import { DashboardPreferencesStore } from "../common/store/dashboard-preferences-store";
import { NodeShellPreferencesStore } from "../common/store/node-shell-preferences-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { startAiChat } from "./ai";
import { startAppearanceOverride } from "./appearance";
import { startPowerButtonStyles } from "./button-styles";
import { DashboardPage } from "./dashboard";
import { SecretCertificateDetails } from "./details/secret-certificate-details";
import { SecureNodeShellMenu } from "./menus/secure-node-shell-menu";
import { PowerPreferences } from "./preferences/preferences";
import { startReadOnlyMode } from "./read-only";
import { startWelcomeOverride } from "./welcome";

import type { ReactNode } from "react";

const PowerEnabled = observer(({ children }: { children: ReactNode }) =>
  PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled ? <>{children}</> : null,
);

export default class FreelensPowerRenderer extends Renderer.LensExtension {
  get name() {
    return EXTENSION_DISPLAY_NAME;
  }
  get sanitizedExtensionId() {
    return EXTENSION_ID;
  }
  get storeName() {
    return this.manifest.storeName || EXTENSION_ID;
  }

  private stopFeatures?: () => void;

  onActivate() {
    const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
    power.loadExtension(this);
    AiPreferencesStore.getInstanceOrCreate().loadExtension(this);
    AiShortcutsStore.getInstanceOrCreate().loadExtension(this);
    ReadOnlyPreferencesStore.getInstanceOrCreate().loadExtension(this);
    NodeShellPreferencesStore.getInstanceOrCreate().loadExtension(this);
    AppearancePreferencesStore.getInstanceOrCreate().loadExtension(this);
    DashboardPreferencesStore.getInstanceOrCreate().loadExtension(this);
    this.stopFeatures?.();
    let disposers: (() => void)[] = [];
    const stop = reaction(
      () => power.enabled,
      (enabled) => {
        for (const dispose of disposers) dispose();
        disposers = [];
        if (enabled) {
          for (const start of [
            startReadOnlyMode,
            startPowerButtonStyles,
            startAppearanceOverride,
            startWelcomeOverride,
            startAiChat,
          ]) {
            try {
              disposers.push(start());
            } catch {
              Common.logger.warn("[Freelens Power] feature could not start", { feature: start.name });
            }
          }
        }
      },
      { fireImmediately: true },
    );
    this.stopFeatures = () => {
      stop();
      for (const dispose of disposers) dispose();
      disposers = [];
    };
  }

  onDeactivate() {
    this.stopFeatures?.();
    this.stopFeatures = undefined;
  }

  appPreferences = [
    {
      id: "freelens-power-settings",
      title: "",
      components: { Input: PowerPreferences, Hint: () => null },
    },
  ];

  globalPages = [
    {
      id: "dashboard",
      components: {
        Page: () => (
          <PowerEnabled>
            <DashboardPage onOpenPreferences={() => this.navigateToPreferences()} />
          </PowerEnabled>
        ),
      },
    },
  ];

  topBarItems = [
    {
      components: {
        Item: () => (
          <PowerEnabled>
            <Renderer.Component.Icon
              material="battery_charging_full"
              className="freelens-power-settings-icon"
              tooltip="Freelens Power settings"
              onClick={() => this.navigateToPreferences()}
            />
          </PowerEnabled>
        ),
      },
    },
  ];

  kubeObjectDetailItems: Renderer.LensExtension["kubeObjectDetailItems"] = [
    {
      kind: "Secret",
      apiVersions: ["v1"],
      priority: 10,
      components: {
        Details: (props) => (
          <PowerEnabled>
            <SecretCertificateDetails {...props} object={props.object as Renderer.K8sApi.Secret} />
          </PowerEnabled>
        ),
      },
    },
  ];

  kubeObjectMenuItems = [
    {
      kind: "Node",
      apiVersions: ["v1"],
      components: {
        MenuItem: (props: Renderer.Component.KubeObjectMenuProps<Renderer.K8sApi.Node>) => (
          <PowerEnabled>
            <SecureNodeShellMenu {...props} />
          </PowerEnabled>
        ),
      },
    },
  ];
}
