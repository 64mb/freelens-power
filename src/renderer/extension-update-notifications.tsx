import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { reaction } from "mobx";
import { useEffect, useRef, useState } from "react";
import { version as VERSION } from "../../package.json";
import {
  EXTENSION_UPDATES_CHANNEL,
  type ExtensionUpdatesStatus,
  isNewerVersion,
  isValidVersion,
} from "../common/extension-updates";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { EXTENSION_UPDATE_STARTED, requestExtensionUpdate } from "./extension-update";

const { Notifications, Button, Icon } = Renderer.Component;
const attemptKey = "freelens-power-update-attempt";
const attemptLifetime = 30 * 60 * 1000;
type Attempt = { version: string; startedAt: number };

function RestartButton({ version, active }: { version: string; active: () => boolean }) {
  const [restarting, setRestarting] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return (
    <Button
      disabled={restarting}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      onClick={async () => {
        if (restarting || !active()) return;
        setRestarting(true);
        try {
          const accepted = await ipcRenderer.invoke(EXTENSION_UPDATES_CHANNEL, { operation: "restart", version });
          if (accepted === true || !active()) return;
        } catch {
          if (!active()) return;
        }
        if (!mounted.current) return;
        setRestarting(false);
        Notifications.error("Could not restart Freelens. Close and reopen it when convenient.");
      }}
    >
      <Icon material="restart_alt" size={16} style={{ margin: 0, padding: 0 }} aria-hidden="true" />
      <span>Restart Freelens</span>
    </Button>
  );
}

function readAttempt(): Attempt | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(attemptKey) ?? "null");
    if (
      isValidVersion(value?.version) &&
      Number.isFinite(value.startedAt) &&
      value.startedAt >= 0 &&
      value.startedAt <= Date.now() &&
      Date.now() - value.startedAt < attemptLifetime
    )
      return value;
  } catch {}
  return undefined;
}

export function startExtensionUpdateNotifications(): () => void {
  if (process.isMainFrame === false) return () => {};
  const preferences = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  let stopped = false;
  let checking = false;
  let current: ExtensionUpdatesStatus | undefined;
  let announced: string | undefined;
  let restartedVersion: string | undefined;
  let removeAvailable: (() => void) | undefined;
  let removeRestart: (() => void) | undefined;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let checkInterval: ReturnType<typeof setInterval> | undefined;
  let statusInterval: ReturnType<typeof setInterval> | undefined;
  let attempt = readAttempt();
  const clearAttempt = () => {
    attempt = undefined;
    clearInterval(statusInterval);
    statusInterval = undefined;
    try {
      sessionStorage.removeItem(attemptKey);
    } catch {}
  };
  const apply = (value: ExtensionUpdatesStatus | null) => {
    if (stopped || !value || !isValidVersion(value.runtimeVersion) || !isValidVersion(value.installedVersion)) return;
    current = value;
    if (
      isNewerVersion(value.installedVersion, value.runtimeVersion) ||
      (attempt && isNewerVersion(value.installedVersion, attempt.version))
    ) {
      removeAvailable?.();
      removeAvailable = undefined;
      clearAttempt();
      if (restartedVersion !== value.installedVersion) {
        restartedVersion = value.installedVersion;
        removeRestart?.();
        removeRestart = Notifications.info(
          <div
            data-power-extension-restart-notice=""
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}
          >
            <div style={{ flex: 1 }}>
              <strong>Freelens Power {value.installedVersion} is installed</strong>
              <p>Restart Freelens when convenient to ensure all changes are loaded.</p>
            </div>
            <RestartButton version={value.installedVersion} active={() => !stopped} />
          </div>,
          { id: "freelens-power-restart-recommended", timeout: 0 },
        );
      }
      return;
    }
    const latest = value.latestVersion;
    if (
      preferences.checkUpdates === false ||
      !isValidVersion(latest, true) ||
      !isNewerVersion(latest, value.installedVersion) ||
      latest === announced
    )
      return;
    announced = latest;
    removeAvailable?.();
    removeAvailable = Notifications.info(
      <div
        data-power-extension-update-notice=""
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}
      >
        <div style={{ flex: 1 }}>
          <strong>Freelens Power {latest} is available</strong>
          <p>Installed version: {value.installedVersion}</p>
        </div>
        <Button
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          onClick={() => {
            if (stopped) return;
            removeAvailable?.();
            removeAvailable = undefined;
            requestExtensionUpdate();
          }}
        >
          <Icon material="system_update_alt" size={16} style={{ margin: 0, padding: 0 }} aria-hidden="true" />
          <span>Update</span>
        </Button>
      </div>,
      { id: "freelens-power-update-available", timeout: 0 },
    );
  };
  const status = async () => {
    if (stopped) return;
    if (attempt && Date.now() - attempt.startedAt >= attemptLifetime) clearAttempt();
    try {
      apply(await ipcRenderer.invoke(EXTENSION_UPDATES_CHANNEL, { operation: "status" }));
    } catch {}
  };
  const watch = () => {
    clearInterval(statusInterval);
    if (attempt) statusInterval = setInterval(() => void status(), 15_000);
  };
  const started = () => {
    attempt = { version: current?.installedVersion ?? VERSION, startedAt: Date.now() };
    try {
      sessionStorage.setItem(attemptKey, JSON.stringify(attempt));
    } catch {}
    watch();
  };
  const check = async () => {
    if (stopped || checking || preferences.checkUpdates === false) return;
    checking = true;
    try {
      apply(await ipcRenderer.invoke(EXTENSION_UPDATES_CHANNEL, { operation: "check" }));
    } catch {
    } finally {
      checking = false;
    }
  };
  const stopPreference = reaction(
    () => preferences.checkUpdates !== false,
    (enabled) => {
      clearTimeout(checkTimer);
      clearInterval(checkInterval);
      removeAvailable?.();
      removeAvailable = undefined;
      announced = undefined;
      if (enabled) {
        checkTimer = setTimeout(() => void check(), 5_000);
        checkInterval = setInterval(() => void check(), 15 * 60 * 1000);
      }
    },
    { fireImmediately: true },
  );
  document.addEventListener(EXTENSION_UPDATE_STARTED, started);
  watch();
  void status();
  return () => {
    stopped = true;
    stopPreference();
    document.removeEventListener(EXTENSION_UPDATE_STARTED, started);
    clearTimeout(checkTimer);
    clearInterval(checkInterval);
    clearInterval(statusInterval);
    removeAvailable?.();
    removeRestart?.();
  };
}
