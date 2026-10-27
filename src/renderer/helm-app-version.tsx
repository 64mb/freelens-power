import { Renderer } from "@freelensapp/extensions";
import { useEffect, useRef, useState } from "react";
import { formatHelmAppVersion, type HelmReleaseMetadata } from "../common/helm";
import {
  type HelmVersion,
  type HelmVersionResult,
  helmVersionIdentity,
  nextHelmVersionRequestId,
  subscribeHelmVersion,
} from "./helm-version-index";
import { NativeTooltip } from "./native-tooltip";

export function HelmAppVersionCell({
  clusterId,
  contextId,
  release,
  active = true,
  refreshToken,
  knownVersion,
}: {
  clusterId: string;
  contextId: string;
  release: HelmReleaseMetadata;
  active?: boolean;
  refreshToken?: string | number;
  knownVersion?: HelmVersion;
}) {
  const target = useRef<HTMLSpanElement>(null);
  const [visibility, setVisibility] = useState({ key: "", visible: false });
  const [manual, setManual] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; result: HelmVersionResult }>();
  const key = helmVersionIdentity(clusterId, contextId, release);
  const stateKey = JSON.stringify([key, refreshToken]);
  const hasKnownVersion = knownVersion !== undefined;
  const visible = visibility.key === key && visibility.visible;
  const priorRefresh = useRef(refreshToken);
  const priorAttempt = useRef(attempt);
  useEffect(() => {
    if (!active || hasKnownVersion) {
      setVisibility({ key, visible: false });
      return;
    }
    if (!target.current || typeof IntersectionObserver === "undefined") return;
    let observed = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (observed) setVisibility({ key, visible: entries.some((entry) => entry.isIntersecting) });
      },
      { root: null },
    );
    observer.observe(target.current);
    return () => {
      observed = false;
      observer.disconnect();
    };
  }, [active, key, hasKnownVersion]);
  useEffect(() => {
    if (hasKnownVersion) {
      setState(undefined);
      priorRefresh.current = refreshToken;
      return;
    }
    if (!active || (!visible && manual !== key)) return;
    let current = true;
    const refresh = priorRefresh.current !== refreshToken || priorAttempt.current !== attempt;
    priorRefresh.current = refreshToken;
    priorAttempt.current = attempt;
    setState(undefined);
    const unsubscribe = subscribeHelmVersion(
      key,
      {
        requestId: nextHelmVersionRequestId(),
        clusterId,
        contextId,
        namespace: release.namespace,
        name: release.name,
        revision: release.revision,
        uid: release.uid,
        operation: "app-version",
      },
      refresh,
      (result) => {
        if (current) setState({ key: stateKey, result });
      },
      "visible",
      JSON.stringify([clusterId, contextId, refreshToken]) + (attempt ? `:retry:${attempt}` : ""),
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [key, active, visible, manual, refreshToken, attempt, hasKnownVersion]);
  const result =
    knownVersion !== undefined ? { value: knownVersion } : state?.key === stateKey ? state.result : undefined;
  const { Icon } = Renderer.Component;
  return (
    <span ref={target} className="helm-app-version-cell">
      {result && "value" in result ? (
        result.value.appVersion ? (
          <NativeTooltip title={result.value.chartVersion ? `Chart version: ${result.value.chartVersion}` : undefined}>
            <span className="helm-version-badge">{formatHelmAppVersion(result.value.appVersion) || "—"}</span>
          </NativeTooltip>
        ) : (
          <span aria-label="Application version unavailable">—</span>
        )
      ) : result && "error" in result ? (
        <NativeTooltip title={result.error}>
          <button
            type="button"
            className="helm-app-version-retry"
            aria-label={`Retry application version for ${release.name} revision ${release.revision}`}
            onClick={(event) => {
              event.stopPropagation();
              setAttempt((value) => value + 1);
            }}
          >
            <Icon material="refresh" size={14} />
          </button>
        </NativeTooltip>
      ) : typeof IntersectionObserver === "undefined" && manual !== key ? (
        <button
          type="button"
          className="helm-app-version-retry"
          aria-label={`Load application version for ${release.name} revision ${release.revision}`}
          onClick={(event) => {
            event.stopPropagation();
            setManual(key);
          }}
        >
          —
        </button>
      ) : (
        <span aria-label="Application version pending" className="helm-app-version-placeholder">
          —
        </span>
      )}
    </span>
  );
}
