import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { startPowerButtonStyles } from "./button-styles";
import { startPodRemovalConfirmation } from "./pod-removal-confirmation";

export function startPodBulkCustomization(): () => void {
  const preferences = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  let stopButtons: (() => void) | undefined;
  let stopConfirmation: (() => void) | undefined;
  const dispose = () => {
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
      if (enabled)
        stopConfirmation = startPodRemovalConfirmation({
          getSelectedNames: () => Renderer.K8sApi.podsStore.selectedItems.map((pod) => pod.getName()),
        });
    },
    { fireImmediately: true },
  );
  return () => {
    stop();
    dispose();
  };
}
