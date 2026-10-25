import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { diagnoseService } from "../../common/service-diagnostics";
import { NativeTooltip } from "../native-tooltip";

const { DrawerTitle, DrawerItem, Icon } = Renderer.Component;
type Evidence = { pods?: Renderer.K8sApi.Pod[]; slices?: Renderer.K8sApi.EndpointSlice[]; loaded: boolean };
export const ServiceDiagnosticsDetails = observer(
  ({ object }: Renderer.Component.KubeObjectDetailsProps<Renderer.K8sApi.Service>) => {
    const [expanded, setExpanded] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [evidence, setEvidence] = useState<Evidence>({ loaded: false });
    const namespace = object.getNs();
    const name = object.getName();
    const external = object.spec.type === "ExternalName";
    useEffect(() => {
      let active = true;
      setEvidence({ loaded: false });
      setExpanded(false);
      if (external) {
        setEvidence({ loaded: true });
        return;
      }
      const load = async () => {
        const [pods, slices] = await Promise.allSettled([
          Renderer.K8sApi.podsApi.list({ namespace }),
          Renderer.K8sApi.endpointSliceApi.list({ namespace }, { labelSelector: `kubernetes.io/service-name=${name}` }),
        ]);
        if (active)
          setEvidence({
            loaded: true,
            pods: pods.status === "fulfilled" ? (pods.value ?? undefined) : undefined,
            slices: slices.status === "fulfilled" ? (slices.value ?? undefined) : undefined,
          });
      };
      void load();
      return () => {
        active = false;
      };
    }, [namespace, name, external, refresh]);
    const result = diagnoseService(object, evidence.pods, evidence.slices);
    const partial =
      !evidence.loaded ||
      evidence.pods === undefined ||
      evidence.slices === undefined ||
      (!!result.readyEndpoints && result.missingEndpointPorts);
    const warning =
      !partial &&
      !external &&
      !!result.matchingPods &&
      (!result.matchingPods.length ||
        !result.readyEndpoints ||
        result.readyPods?.length !== result.matchingPods.length ||
        result.ports.some((port) => port.unresolved || port.numericMismatch));
    const healthy = !partial && !external && !!result.matchingPods?.length && !warning;
    const summaryColor = warning ? "var(--colorWarning)" : healthy ? "var(--colorOk)" : "var(--textColorSecondary)";
    const listLimit = expanded ? Infinity : 5;
    const hidden =
      Math.max(0, (result.matchingPods?.length ?? 0) - 5) + Math.max(0, (result.matchingSlices?.length ?? 0) - 5);
    return (
      <>
        <DrawerTitle>
          <span
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%" }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>Service backend diagnostics</span>
            {!external && (
              <NativeTooltip title="Refresh backend evidence">
                <button
                  type="button"
                  aria-label="Refresh evidence"
                  disabled={!evidence.loaded}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 32,
                    height: 32,
                    flexShrink: 0,
                    padding: 0,
                    background: "transparent",
                    border: 0,
                    color: "var(--textColorSecondary)",
                    cursor: evidence.loaded ? "pointer" : "default",
                    opacity: evidence.loaded ? 1 : 0.4,
                  }}
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  <Icon material="refresh" size={18} />
                </button>
              </NativeTooltip>
            )}
          </span>
        </DrawerTitle>
        <DrawerItem name="Summary">
          <span style={{ color: summaryColor }}>
            <Icon material={warning ? "warning" : healthy ? "check_circle" : "info"} />{" "}
            {evidence.loaded ? result.summary : "Loading backend evidence…"}
          </span>
        </DrawerItem>
        {evidence.loaded && (
          <>
            <DrawerItem name="Selector">
              {Object.entries(object.spec.selector ?? {})
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "None"}
            </DrawerItem>
            {result.ports.map((p) => (
              <DrawerItem key={p.name} name={`Port ${p.name}`}>
                {p.protocol} → {p.target} · EndpointSlice ports: {p.endpointPorts.join(", ") || "unavailable"}
                {p.unresolved ? ` · named target unresolved in ${p.unresolved} selected pods` : ""}
                {p.numericMismatch ? " · EndpointSlice port differs from numeric target" : ""}
              </DrawerItem>
            ))}
            {result.matchingPods?.slice(0, listLimit).map((pod) => (
              <DrawerItem key={pod.metadata.uid} name="Selected pod">
                <button
                  type="button"
                  onClick={() => Renderer.Navigation.showDetails(pod.selfLink)}
                  style={{
                    background: "transparent",
                    border: 0,
                    padding: 0,
                    color: "var(--primary)",
                    cursor: "pointer",
                  }}
                >
                  {pod.getName()}
                </button>
              </DrawerItem>
            ))}
            {result.matchingSlices?.slice(0, listLimit).map((slice) => (
              <DrawerItem key={slice.metadata.uid} name={`EndpointSlice (${slice.addressType})`}>
                <button
                  type="button"
                  onClick={() => Renderer.Navigation.showDetails(slice.selfLink)}
                  style={{
                    background: "transparent",
                    border: 0,
                    padding: 0,
                    color: "var(--primary)",
                    cursor: "pointer",
                  }}
                >
                  {slice.getName()}
                </button>
              </DrawerItem>
            ))}
            {hidden > 0 && (
              <button type="button" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Show fewer resources" : `Show ${hidden} more resources`}
              </button>
            )}
            {result.limitations.map((item) => (
              <DrawerItem key={item} name="Scope">
                {item}
              </DrawerItem>
            ))}
          </>
        )}
      </>
    );
  },
);
