import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { diagnoseHpa } from "../../common/hpa-diagnostics";

const { DrawerTitle, DrawerItem, Icon } = Renderer.Component;
export const HpaDiagnosticsDetails = observer(
  ({ object }: Renderer.Component.KubeObjectDetailsProps<Renderer.K8sApi.HorizontalPodAutoscaler>) => {
    const result = diagnoseHpa(object);
    const healthy =
      result.state !== "warning" &&
      result.min !== result.max &&
      object.status?.conditions?.some(
        (condition) => condition.type === "ScalingActive" && condition.status === "True",
      ) &&
      object.status?.conditions?.some((condition) => condition.type === "AbleToScale" && condition.status === "True") &&
      !object.status?.conditions?.some(
        (condition) => condition.type === "ScalingLimited" && condition.status === "True",
      );
    return (
      <>
        <DrawerTitle>Autoscaling diagnostics</DrawerTitle>
        <DrawerItem name="Summary">
          <span
            style={{
              color:
                result.state === "warning"
                  ? "var(--colorWarning)"
                  : healthy
                    ? "var(--colorOk)"
                    : "var(--textColorSecondary)",
            }}
          >
            <Icon material={result.state === "warning" ? "warning" : healthy ? "check_circle" : "info"} />{" "}
            {result.summary}
          </span>
        </DrawerItem>
        <DrawerItem name="Replicas">
          Current {result.current ?? "unknown"} · desired {result.desired ?? "unknown"} · min {result.min} · max{" "}
          {result.max ?? "unknown"}
        </DrawerItem>
        {result.evidence.map((item) => (
          <DrawerItem key={item} name="Evidence">
            {item}
          </DrawerItem>
        ))}
      </>
    );
  },
);
