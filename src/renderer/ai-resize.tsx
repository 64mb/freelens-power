import { useEffect, useRef } from "react";

export const DEFAULT_AI_PANEL_WIDTH = 560;
export const MIN_AI_PANEL_WIDTH = 360;

export function clampAiPanelWidth(width: number, available: number): number {
  const maximum = Math.max(1, available);
  return Math.min(
    maximum,
    Math.max(Math.min(MIN_AI_PANEL_WIDTH, maximum), Number.isFinite(width) ? width : DEFAULT_AI_PANEL_WIDTH),
  );
}

export function AiResizeHandle({
  width,
  available,
  onChange,
}: {
  width: number;
  available: number;
  onChange: (width: number) => void;
}) {
  const drag = useRef<{ x: number; y: number; width: number; movement: number; pointerId: number }>();
  const change = useRef(onChange);
  const limit = useRef(available);
  change.current = onChange;
  limit.current = available;
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = drag.current;
      if (!start || event.pointerId !== start.pointerId) return;
      const delta = start.x - event.clientX;
      start.movement = Math.max(start.movement, Math.hypot(delta, start.y - event.clientY));
      if (start.movement > 4) change.current(clampAiPanelWidth(start.width + delta, limit.current));
    };
    const end = (event: PointerEvent) => {
      const start = drag.current;
      if (!start || event.pointerId !== start.pointerId) return;
      start.movement = Math.max(start.movement, Math.hypot(start.x - event.clientX, start.y - event.clientY));
      if (start.movement <= 4) change.current(DEFAULT_AI_PANEL_WIDTH);
      else change.current(clampAiPanelWidth(start.width + start.x - event.clientX, limit.current));
      drag.current = undefined;
    };
    const cancel = () => {
      drag.current = undefined;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize AI assistant"
      aria-orientation="vertical"
      aria-valuemin={Math.min(MIN_AI_PANEL_WIDTH, available)}
      aria-valuemax={Math.max(1, available)}
      aria-valuenow={width}
      title="Drag to resize · Click to reset width"
      className="power-ai-resize-handle"
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = { x: event.clientX, y: event.clientY, width, movement: 0, pointerId: event.pointerId };
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        onChange(
          event.key === "Home"
            ? DEFAULT_AI_PANEL_WIDTH
            : clampAiPanelWidth(width + (event.key === "ArrowLeft" ? 20 : -20), available),
        );
      }}
    />
  );
}
