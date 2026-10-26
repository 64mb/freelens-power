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
const pinPath =
  "m191.495 55.511-54.046-54.046c-1.951-1.953-5.119-1.953-7.07 0l-.229.229c-3.314 3.313-5.14 7.72-5.14 12.406 0 3.019.767 5.916 2.192 8.485l-56.55 48.533c-4.328-3.868-9.852-5.985-15.703-5.985-6.305 0-12.232 2.455-16.689 6.913l-.339.339c-1.953 1.952-1.953 5.118 0 7.07l32.378 32.378-31.534 31.533c-.631.649-15.557 16.03-25.37 28.27-9.345 11.653-11.193 13.788-11.289 13.898-1.735 1.976-1.639 4.956.218 6.822.973.977 2.256 1.471 3.543 1.471 1.173 0 2.349-.41 3.295-1.237.083-.072 2.169-1.885 13.898-11.289 12.238-9.813 27.619-24.74 28.318-25.421l31.483-31.483 30.644 30.644c.976.977 2.256 1.465 3.535 1.465s2.56-.488 3.535-1.465l.339-.339c4.458-4.457 6.913-10.385 6.913-16.689 0-5.851-2.118-11.375-5.985-15.703l48.533-56.55c2.569 1.425 5.466 2.192 8.485 2.192 4.687 0 9.093-1.825 12.406-5.14l.229-.229c1.953-1.954 1.953-5.12 0-7.072z";
const unpinPath =
  "M2,5.27L3.28,4L20,20.72L18.73,22L12.8,16.07V22H11.2V16H6V14L8,12V11.27L2,5.27M16,12L18,14V16H17.82L8,6.18V4H7V2H17V4H16V12Z";

export function AiPinIcon({ pinned, size = 18 }: { pinned: boolean; size?: number }) {
  return (
    <span className="Icon svg" aria-hidden="true" style={{ "--size": `${size}px` } as CSSProperties}>
      <span className="icon">
        <svg viewBox={pinned ? "0 0 24 24" : "0 0 193.826 193.826"} width={size} height={size} focusable="false">
          <path fill="currentColor" d={pinned ? unpinPath : pinPath} />
        </svg>
      </span>
    </span>
  );
}
