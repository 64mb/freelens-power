import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { MAX_SAMPLES, type MonitoringSample } from "../common/monitoring-math";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import { getMonitoringSnapshot, getNodeSample, retainMonitoringCollector } from "./monitoring-collector";
import { MonitoringDetailsChart } from "./monitoring-details-chart";
import { useMonitoringHistory } from "./monitoring-history-view";

type NodeProps = Renderer.Component.KubeObjectDetailsProps<Renderer.K8sApi.Node>;

const NodeMonitoringCharts = observer(({ object }: NodeProps) => {
  const clusterId = Renderer.Catalog.activeCluster.get()?.metadata.uid;
  const name = object.metadata.name;
  const uid = object.metadata.uid;
  const identity = JSON.stringify([clusterId, name, uid]);
  const [metric, setMetric] = useState<"cpu" | "memory">("cpu");
  const [state, setState] = useState<{ identity: string; samples: MonitoringSample[]; status: string }>({
    identity,
    samples: [],
    status: "",
  });
  useEffect(() => {
    let stopped = false;
    let pending = false;
    const release = retainMonitoringCollector();
    setState({ identity, samples: [], status: "" });
    const current = () =>
      !stopped &&
      Renderer.Catalog.activeCluster.get()?.metadata.uid === clusterId &&
      object.metadata.name === name &&
      object.metadata.uid === uid;
    const update = async () => {
      if (pending || !clusterId || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const snapshot = await getMonitoringSnapshot();
        if (!current() || snapshot.clusterId !== clusterId) return;
        const node = snapshot.nodes?.find((candidate) => candidate.metadata.name === name);
        const replaced = !!uid && !!node?.metadata.uid && node.metadata.uid !== uid;
        const sample = replaced ? undefined : getNodeSample(snapshot, name, uid);
        setState((previous) => {
          const retained = (previous.identity === identity && !replaced ? previous.samples : []).filter(
            (entry) => entry.time >= Date.now() - 30 * 60_000,
          );
          return {
            identity,
            samples: sample
              ? [...retained.filter((entry) => entry.time !== sample.time), sample]
                  .sort((a, b) => a.time - b.time)
                  .slice(-MAX_SAMPLES)
              : retained,
            status: sample
              ? ""
              : "Node metrics unavailable, stale or access denied. Last collected samples remain visible.",
          };
        });
      } catch {
        if (current())
          setState((previous) => ({
            identity,
            samples:
              previous.identity === identity
                ? previous.samples.filter((entry) => entry.time >= Date.now() - 30 * 60_000)
                : [],
            status: "Node metrics unavailable, stale or access denied. Last collected samples remain visible.",
          }));
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(() => {
      void update();
    }, 1000);
    void update();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      release();
    };
  }, [clusterId, identity, name, object, uid]);
  const samples = state.identity === identity ? state.samples : [];
  const status = state.identity === identity ? state.status : "";
  const history = useMonitoringHistory(clusterId && uid ? { clusterId, scope: "node", uid } : undefined, samples);
  return (
    <div data-power-node-monitoring="">
      <style>{`
        .KubeObjectDetails:has([data-power-node-monitoring]) .ResourceMetrics,
        .KubeObjectDetails:has([data-power-node-monitoring]) [data-time-range]:has(+ .ResourceMetrics) {
          display: none !important;
        }
      `}</style>
      <div style={{ marginBottom: 16 }}>
        <Renderer.Component.RadioGroup value={metric} onChange={setMetric} asButtons>
          <Renderer.Component.Radio value="cpu" label="CPU" />
          <Renderer.Component.Radio value="memory" label="Memory" />
        </Renderer.Component.RadioGroup>
      </div>
      <MonitoringDetailsChart
        key={`${identity}:${metric}`}
        metric={metric}
        samples={history.samples}
        status={status}
        native
        range={history.range}
        onRangeChange={history.setRange}
        historyStatus={history.status}
      />
    </div>
  );
});

export const NodeMonitoringDetails = observer((props: NodeProps) => {
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  return preferences.enabled ? <NodeMonitoringCharts {...props} /> : null;
});
