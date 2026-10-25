import { Renderer } from "@freelensapp/extensions";
import { cloneElement, type ReactElement, type ReactNode, useState } from "react";

let nextTooltipId = 0;

export function NativeTooltip({ children, title }: { children: ReactElement; title?: ReactNode }) {
  const [generatedId] = useState(() => `power-tooltip-${++nextTooltipId}`);
  const targetId = children.props.id || generatedId;
  const Tooltip = Renderer.Component?.Tooltip;
  return (
    <>
      {cloneElement(children, { id: targetId, title: undefined })}
      {title != null && title !== "" && Tooltip ? (
        <Tooltip
          key={`${targetId}:${String(children.type)}:${children.key ?? ""}`}
          targetId={targetId}
          formatters={{ narrow: true }}
        >
          {title}
        </Tooltip>
      ) : null}
    </>
  );
}
