import { observable, runInAction } from "mobx";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectedItems: [{ getName: (): string => "pod-a" }],
  preferences: { nodeBulkActions: true },
  buttons: vi.fn(),
  confirmation: vi.fn(),
  secretDialog: vi.fn(() => vi.fn()),
  transitions: vi.fn(() => vi.fn()),
  stopButtons: vi.fn(),
  stopConfirmation: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: { K8sApi: { podsStore: mocks, secretsStore: mocks, roleStore: mocks } },
}));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("./secret-dialog-customization", () => ({ startSecretDialogCustomization: mocks.secretDialog }));
vi.mock("./button-styles", () => ({ startPowerButtonStyles: mocks.buttons }));
vi.mock("./floating-action-transitions", () => ({ startFloatingActionTransitions: mocks.transitions }));
vi.mock("./pod-removal-confirmation", () => ({ startPodRemovalConfirmation: mocks.confirmation }));

import { startPodBulkCustomization } from "./pod-bulk-customization";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preferences = observable({ nodeBulkActions: true });
  mocks.buttons.mockReturnValue(mocks.stopButtons);
  mocks.confirmation.mockReturnValue(mocks.stopConfirmation);
});

it("restores native Pod actions immediately and reenables customization without duplicate listeners", () => {
  const stop = startPodBulkCustomization();
  expect(mocks.buttons).toHaveBeenLastCalledWith(true);
  expect(mocks.transitions).toHaveBeenLastCalledWith(true);
  expect(mocks.confirmation).toHaveBeenCalledOnce();
  runInAction(() => {
    mocks.preferences.nodeBulkActions = false;
  });
  expect(mocks.stopButtons).toHaveBeenCalledOnce();
  expect(mocks.stopConfirmation).toHaveBeenCalledOnce();
  expect(mocks.buttons).toHaveBeenLastCalledWith(false);
  expect(mocks.transitions).toHaveBeenLastCalledWith(false);
  expect(mocks.confirmation).toHaveBeenCalledOnce();
  runInAction(() => {
    mocks.preferences.nodeBulkActions = true;
  });
  expect(mocks.stopButtons).toHaveBeenCalledTimes(2);
  expect(mocks.confirmation).toHaveBeenCalledTimes(2);
  stop();
  expect(mocks.stopButtons).toHaveBeenCalledTimes(3);
  expect(mocks.stopConfirmation).toHaveBeenCalledTimes(2);
  runInAction(() => {
    mocks.preferences.nodeBulkActions = false;
  });
  expect(mocks.buttons).toHaveBeenCalledTimes(3);
});

it("starts disabled with native Pod actions and retains other button styling", () => {
  mocks.preferences.nodeBulkActions = false;
  const stop = startPodBulkCustomization();
  expect(mocks.buttons).toHaveBeenCalledExactlyOnceWith(false);
  expect(mocks.confirmation).not.toHaveBeenCalled();
  stop();
  expect(mocks.stopButtons).toHaveBeenCalledOnce();
});

it("reads the live selection only when the confirmation requests its snapshot", () => {
  const stop = startPodBulkCustomization();
  const options = mocks.confirmation.mock.calls[0][0];
  expect(options.getSelectedNames()).toEqual(["pod-a"]);
  mocks.selectedItems = [{ getName: () => "pod-b" }];
  expect(options.getSelectedNames()).toEqual(["pod-b"]);
  stop();
});

it("starts Secret dialog styling only while bulk customization is enabled", () => {
  const stop = startPodBulkCustomization();
  expect(mocks.secretDialog).toHaveBeenCalledOnce();
  expect(mocks.confirmation.mock.calls[0][0].getSelectedSecretNames()).toEqual(
    mocks.selectedItems.map((item) => item.getName()),
  );
  runInAction(() => {
    mocks.preferences.nodeBulkActions = false;
  });
  expect(mocks.secretDialog).toHaveBeenCalledOnce();
  stop();
});

it("uses exported resource stores for generic removal snapshots and leaves unsupported stores unavailable", () => {
  const stop = startPodBulkCustomization();
  const options = mocks.confirmation.mock.calls[0][0];
  expect(options.getSelectedResourceNames("Roles")).toEqual(mocks.selectedItems.map((item) => item.getName()));
  expect(options.getSelectedResourceNames("CustomResources")).toBeUndefined();
  expect(options.getSelectedResourceNames("ResourceQuotas")).toBeUndefined();
  stop();
});
