import { Renderer } from "@freelensapp/extensions";
import { cloneElement, type ReactElement, useState } from "react";

let nextTooltipId = 0;

export function NativeTooltip({
  children,
  title,
}: {
  children: ReactElement;
  title?: Renderer.Component.TooltipProps["children"];
}) {
  const [generatedId] = useState(() => `power-tooltip-${++nextTooltipId}`);
  const target = children as ReactElement<{ id?: string; title?: string }>;
  const targetId = target.props.id || generatedId;
  const Tooltip = Renderer.Component?.Tooltip;
  return (
    <>
      {cloneElement(target, { id: targetId, title: undefined })}
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
