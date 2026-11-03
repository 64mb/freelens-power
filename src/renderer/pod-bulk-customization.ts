import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { startPowerButtonStyles } from "./button-styles";
import { startFloatingActionTransitions } from "./floating-action-transitions";
import { nativeResourceRemovals } from "./native-resource-removals";
import { startPodRemovalConfirmation } from "./pod-removal-confirmation";
import { startSecretDialogCustomization } from "./secret-dialog-customization";

export function startPodBulkCustomization(): () => void {
  const preferences = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  let stopButtons: (() => void) | undefined;
  let stopTransitions: (() => void) | undefined;
  let stopSecretDialog: (() => void) | undefined;
  let stopConfirmation: (() => void) | undefined;
  const dispose = () => {
    stopTransitions?.();
    stopTransitions = undefined;
    stopSecretDialog?.();
    stopSecretDialog = undefined;
    stopConfirmation?.();
    stopButtons?.();
    stopConfirmation = undefined;
    stopButtons = undefined;
  };
  const stop = reaction(
    () => preferences.nodeBulkActions !== false,
    (enabled) => {
      dispose();
      stopButtons = startPowerButtonStyles(enabled);
      stopTransitions = startFloatingActionTransitions(enabled);
      if (enabled) {
        stopSecretDialog = startSecretDialogCustomization();
        stopConfirmation = startPodRemovalConfirmation({
          getSelectedResourceNames: (root) => {
            const key = nativeResourceRemovals[root]?.store;
            if (!key) return;
            const stores = Renderer.K8sApi as unknown as Record<
              string,
              { selectedItems?: { getName(): string }[] } | undefined
            >;
            return stores[key]?.selectedItems?.map((item) => item.getName());
          },
          getSelectedNames: () => Renderer.K8sApi.podsStore.selectedItems.map((pod) => pod.getName()),
          getSelectedSecretNames: () => Renderer.K8sApi.secretsStore.selectedItems.map((secret) => secret.getName()),
        });
      }
    },
    { fireImmediately: true },
  );
  return () => {
    stop();
    dispose();
  };
}
