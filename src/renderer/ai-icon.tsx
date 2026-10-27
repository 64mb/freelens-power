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

// native Freelens pin paths are MIT licensed, see [THIRD_PARTY_LICENSES]
const unpinPath =
  "M2,5.27L3.28,4L20,20.72L18.73,22L12.8,16.07V22H11.2V16H6V14L8,12V11.27L2,5.27M16,12L18,14V16H17.82L8,6.18V4H7V2H17V4H16V12Z";

export function AiPinIcon({ pinned, size = 18 }: { pinned: boolean; size?: number }) {
  if (!pinned) return <AiIcon material="push_pin" size={size} />;
  return (
    <span className="Icon svg" aria-hidden="true" style={{ "--size": `${size}px` } as CSSProperties}>
      <span className="icon">
        <svg viewBox="0 0 24 24" width={size} height={size} focusable="false">
          <path fill="currentColor" d={unpinPath} />
        </svg>
      </span>
    </span>
  );
}
