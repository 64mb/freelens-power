import type { CSSProperties } from "react";

export function AiIcon({ material, size = 16 }: { material: string; size?: number }) {
  return (
    <span
      className="Icon material"
      aria-hidden="true"
      style={{ "--size": `${size}px`, fontWeight: 400 } as CSSProperties}
    >
      <span className="icon">{material}</span>
    </span>
  );
}
