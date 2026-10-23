import { Renderer } from "@freelensapp/extensions";
import { useEffect, useState } from "react";
import { formatDateTime } from "../../common/date-time";
import { effectivePodResource } from "../../common/monitoring-math";
import { getMonitoringSnapshot, type MonitoringSnapshot, retainMonitoringCollector } from "../monitoring-collector";
import { ResourceHealthDetails, type ResourceHealthDetailsProps } from "./resource-health-details";

const { DrawerItem } = Renderer.Component;

export function NamespaceHealthDetails(props: ResourceHealthDetailsProps) {
  const namespace = props.object.getName();
  const clusterId = Renderer.Catalog.activeCluster.get()?.metadata.uid;
  const [result, setResult] = useState<{
    namespace: string;
    clusterId: string;
    snapshot?: MonitoringSnapshot;
    failed?: boolean;
  }>();
  useEffect(() => {
    let active = true;
    const release = retainMonitoringCollector();
    const refresh = () => {
      void getMonitoringSnapshot().then(
        (snapshot) => {
          if (active) setResult({ namespace, clusterId: snapshot.clusterId, snapshot });
        },
        () => {
          if (active && clusterId) setResult({ namespace, clusterId, failed: true });
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
      release();
    };
  }, [namespace, clusterId]);
  const snapshot = result?.namespace === namespace && result?.clusterId === clusterId ? result.snapshot : undefined;
  const pods = snapshot?.pods?.filter((pod) => pod.getNs() === namespace);
  const activePods = pods?.filter((pod) => pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed");
  let requests: string | undefined;
  if (activePods) {
    try {
      const cpu = activePods.reduce((sum, pod) => sum + effectivePodResource(pod, "cpu", "requests"), 0);
      const memory = activePods.reduce((sum, pod) => sum + effectivePodResource(pod, "memory", "requests"), 0);
      requests = `${cpu.toFixed(2)} CPU cores · ${(memory / 1024 ** 2).toFixed(0)} MiB memory`;
    } catch {
      requests = "Unavailable: incomplete resource specifications";
    }
  }
  const failed = result?.namespace === namespace && result?.clusterId === clusterId && result.failed;
  return (
    <>
      <ResourceHealthDetails
        {...props}
        onOpenDiagnostics={props.onOpenDiagnostics ? () => props.onOpenDiagnostics?.(namespace) : undefined}
      />
      <DrawerItem name="Inventory scope">Namespace {namespace}, from the API-visible pod inventory</DrawerItem>
      <DrawerItem name="Pod coverage">
        {pods
          ? `${pods.length} visible pods · ${activePods?.length} non-terminal`
          : failed || snapshot
            ? "Unavailable or access denied"
            : "Loading"}
      </DrawerItem>
      {activePods && (
        <DrawerItem name="Pod readiness">
          {
            activePods.filter((pod) =>
              pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"),
            ).length
          }
          /{activePods.length} non-terminal pods ready
        </DrawerItem>
      )}
      {requests && <DrawerItem name="Pod requests">{requests}</DrawerItem>}
      <DrawerItem name="Coverage">
        Filtered to this namespace · visibility may be limited by access permissions
        {snapshot ? ` · sampled ${formatDateTime(snapshot.time)}` : ""}
      </DrawerItem>
    </>
  );
}
