import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { type HealthObject, summarizeObjectHealth } from "../../common/resource-health";
import { AiPreferencesStore } from "../../common/store/ai-preferences-store";
import { explainDiagnosticFinding } from "../ai-diagnostic-handoff";

const { Button, DrawerItem, DrawerTitle, Icon } = Renderer.Component;
const actionStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minHeight: 28,
  padding: "4px 8px",
  border: "1px solid var(--borderFaintColor)",
  background: "var(--buttonDefaultBackground)",
} as const;

export type ResourceHealthDetailsProps = Renderer.Component.KubeObjectDetailsProps & {
  onOpenDiagnostics?: (namespace?: string) => void;
};

export const ResourceHealthDetails = observer(({ object, onOpenDiagnostics }: ResourceHealthDetailsProps) => {
  const health = summarizeObjectHealth(object as HealthObject);
  const namespace = object.getNs();
  const clusterId = Renderer.Catalog.activeCluster.get()?.metadata.uid;
  const aiEnabled = AiPreferencesStore.getInstanceOrCreate<AiPreferencesStore>().enabled;
  const askAi = () => {
    if (!clusterId || !AiPreferencesStore.getInstanceOrCreate<AiPreferencesStore>().enabled) return;
    const name = object.getName();
    explainDiagnosticFinding({
      clusterId,
      title: `${object.kind} ${name}: operational summary`.slice(0, 160),
      summary: [
        ...health.rows.map((row) => `${row.name}: ${row.value}`),
        ...(health.issue ? [`Key issue: ${health.issue}`] : []),
      ]
        .join("\n")
        .slice(0, 6000),
      resource: { kind: object.kind, name, ...(namespace ? { namespace } : {}) },
    });
  };
  const node = (object as HealthObject).spec?.nodeName;
  const open = (path: string) => {
    void Promise.resolve(Renderer.Navigation.showDetails(path)).catch(() => {});
  };
  return (
    <section className="power-operational-summary" style={{ marginBottom: 16 }}>
      <style>{`
        .power-operational-summary > .DrawerTitle.power-operational-title { margin-bottom: 10px; }
        .power-operational-summary .power-resource-action::before { content: none; }
        .power-operational-summary .power-resource-action:active { filter: brightness(1.12); }
        .power-operational-summary .power-resource-action:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
      `}</style>
      <DrawerTitle className="power-operational-title">Operational summary</DrawerTitle>
      <DrawerItem name="Health">
        <span
          style={{
            color:
              health.state === "healthy"
                ? "var(--colorOk)"
                : health.state === "warning"
                  ? "var(--colorWarning)"
                  : "var(--textColorSecondary)",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Icon
            material={
              health.state === "healthy" ? "check_circle" : health.state === "warning" ? "warning" : "help_outline"
            }
          />
          {health.state === "healthy" ? "Healthy" : health.state === "warning" ? "Needs attention" : "Unknown"}
        </span>
      </DrawerItem>
      {health.rows.map((row) => (
        <DrawerItem key={row.name} name={row.name}>
          {row.value}
        </DrawerItem>
      ))}
      {health.issue && <DrawerItem name="Key issue">{health.issue}</DrawerItem>}
      {namespace && object.kind !== "Namespace" && (
        <DrawerItem name="Namespace">
          <button
            type="button"
            className="link"
            onClick={() => open(Renderer.K8sApi.namespacesApi.getUrl({ name: namespace }))}
          >
            {namespace}
          </button>
        </DrawerItem>
      )}
      <DrawerItem name="Investigate">
        <span style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {onOpenDiagnostics && (
            <Button className="power-resource-action" onClick={() => onOpenDiagnostics(namespace)} style={actionStyle}>
              <Icon material="insights" size={14} aria-hidden="true" /> Open Diagnostics
            </Button>
          )}
          <Button
            className="power-resource-action"
            onClick={askAi}
            disabled={!aiEnabled || !clusterId}
            title={
              !aiEnabled
                ? "Enable the AI assistant in settings"
                : !clusterId
                  ? "Select a connected cluster"
                  : "Attach this summary to the AI chat"
            }
            style={actionStyle}
          >
            <Icon material="auto_awesome" size={14} aria-hidden="true" /> Ask AI
          </Button>
        </span>
      </DrawerItem>
      {node && (
        <DrawerItem name="Node">
          <button type="button" className="link" onClick={() => open(Renderer.K8sApi.nodesApi.getUrl({ name: node }))}>
            {node}
          </button>
        </DrawerItem>
      )}
    </section>
  );
});
