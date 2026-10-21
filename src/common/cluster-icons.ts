export interface ClusterIconDesign {
  label: string;
  outlineColor: string;
  labelColor: string;
  glyph: string;
  iconColor: string;
}

// glyphs share the reference fitting, with Lucide contours for [key] and [rocket]
export const GLYPHS = Object.freeze([
  Object.freeze({
    id: "window",
    label: "Window",
    body: '<g transform="translate(32 11.4) scale(1.168000000) translate(-32 -14)" stroke-width="2.397260274"><rect x="16" y="14" width="32" height="25" rx="4"/><path d="M16 22h32M23 18h.1M28 18h.1M24 28l-4 3 4 3M35 28h7M35 34h5"/></g>',
  }),
  Object.freeze({
    id: "server",
    label: "Server",
    body: '<g transform="translate(32 11.4) scale(1.006896552) translate(-32 -13)" stroke-width="2.780821917"><rect x="17" y="13" width="30" height="12" rx="4"/><rect x="17" y="30" width="30" height="12" rx="4"/><path d="M23 19h.1M23 36h.1M32 19h8M32 36h8"/></g>',
  }),
  Object.freeze({
    id: "database",
    label: "Database",
    body: '<g transform="translate(32 11.4) scale(0.941935484) translate(-32 -11)" stroke-width="2.972602739"><ellipse cx="32" cy="17" rx="15" ry="6"/><path d="M17 17v19c0 8 30 8 30 0V17M17 26c0 8 30 8 30 0"/></g>',
  }),
  Object.freeze({
    id: "briefcase",
    label: "Briefcase",
    body: '<g transform="translate(32 11.4) scale(0.973333333) translate(-32 -13)" stroke-width="2.876712330"><rect x="14" y="20" width="36" height="23" rx="4"/><path d="M25 20v-5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5M14 28c10 7 26 7 36 0"/><rect x="29" y="29" width="6" height="7" rx="1.5" fill="#292d38"/></g>',
  }),
  Object.freeze({
    id: "sailboat",
    label: "Sailboat",
    body: '<g transform="translate(32 11.4) scale(0.834285714) translate(-32 -11)" stroke-width="3.356164385"><path d="M31 11v23H17zM36 18l11 16H36zM13 39h38l-7 7H21z"/></g>',
  }),
  Object.freeze({
    id: "network",
    label: "Network",
    body: '<g transform="translate(32 11.4) scale(0.768421053) translate(-32 -7)" stroke-width="3.643835615"><circle cx="32" cy="26" r="7"/><path d="M32 13v6M32 33v6M19 26h6M39 26h6"/><circle cx="32" cy="10" r="3"/><circle cx="32" cy="42" r="3"/><circle cx="16" cy="26" r="3"/><circle cx="48" cy="26" r="3"/></g>',
  }),
  Object.freeze({
    id: "box",
    label: "Box",
    body: '<g transform="translate(32 11.4) scale(0.834285714) translate(-32 -11)" stroke-width="3.356164385"><path d="M32 11l17 10v17L32 46 15 38V21zM15 21l17 9 17-9M32 30v16"/></g>',
  }),
  Object.freeze({
    id: "blocks",
    label: "Blocks",
    body: '<rect x="17" y="11.4" width="10" height="9" rx="1.6"/><rect x="37" y="11.4" width="10" height="9" rx="1.6"/><rect x="27" y="31.6" width="10" height="9" rx="1.6"/><path d="M22 20.4V26h20v-5.6M32 26v5.6"/>',
  }),
  Object.freeze({
    id: "git-branch",
    label: "Git branch",
    body: '<g transform="translate(32 11.4) scale(0.973333333) translate(-32 -12)" stroke-width="2.876712330"><circle cx="22" cy="16" r="4"/><circle cx="42" cy="16" r="4"/><circle cx="22" cy="38" r="4"/><path d="M22 20v14M42 20c0 10-20 3-20 13"/></g>',
  }),
  Object.freeze({
    id: "cloud",
    label: "Cloud",
    body: '<path d="M22 40.6c-6 0-10-4-10-10 0-5 3-9 8-10 0-5 5-9.2 12-9.2s12 5 12 12c5 0 8 4 8 9 0 5-4 8.2-9 8.2z"/>',
  }),
  Object.freeze({
    id: "cpu",
    label: "CPU",
    body: '<rect x="21" y="15" width="22" height="22" rx="4"/><rect x="27" y="21" width="10" height="10" rx="1"/><path d="M26 11.4V15M32 11.4V15M38 11.4V15M26 37v3.6M32 37v3.6M38 37v3.6M17.4 20H21M17.4 26H21M17.4 32H21M43 20h3.6M43 26h3.6M43 32h3.6"/>',
  }),
  Object.freeze({
    id: "shield",
    label: "Shield",
    body: '<path d="M32 11.4l13 5v10c0 7-6 12-13 14.2C25 38.4 19 33.4 19 26.4v-10zM25 26l5 5 9-10"/>',
  }),
  Object.freeze({
    id: "globe",
    label: "Globe",
    body: '<circle cx="32" cy="26" r="14.6"/><ellipse cx="32" cy="26" rx="6.5" ry="14.6"/><path d="M17.4 26h29.2M20.2 17.5h23.6M20.2 34.5h23.6"/>',
  }),
  Object.freeze({
    id: "key",
    label: "Key",
    body: '<g transform="translate(32 11.4) scale(1.39047619) translate(-12.5 -1)" stroke-width="2.01369863"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" stroke-width="1"/></g>',
  }),
  Object.freeze({
    id: "rocket",
    label: "Rocket",
    body: '<g transform="translate(32 11.4) scale(1.497435897) translate(-12.25 -2)" stroke-width="1.869863014"><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"/></g>',
  }),
]);
const COLOR = /^#[\da-f]{6}$/i;
const LABEL = /^[\p{L}\p{N}\p{M}\p{P}\p{S} ]*$/u;

export function normalizeClusterIconDesign(input: unknown): ClusterIconDesign {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid cluster icon design");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.label !== "string" || !LABEL.test(value.label)) {
    throw new Error("Use up to three visible characters for the label");
  }
  const label = value.label.normalize("NFC").trim();
  if (Array.from(label).length > 3) {
    throw new Error("Use up to three visible characters for the label");
  }
  if (typeof value.glyph !== "string" || !GLYPHS.some((glyph) => glyph.id === value.glyph)) {
    throw new Error("Choose an available cluster icon");
  }
  const colors = ["outlineColor", "labelColor", "iconColor"] as const;
  for (const key of colors) {
    if (typeof value[key] !== "string" || !COLOR.test(value[key] as string)) {
      throw new Error("Use a six-digit hexadecimal color");
    }
  }
  return {
    label,
    glyph: value.glyph,
    outlineColor: (value.outlineColor as string).toLowerCase(),
    labelColor: (value.labelColor as string).toLowerCase(),
    iconColor: (value.iconColor as string).toLowerCase(),
  };
}

export function defaultClusterIconDesign(name: string): ClusterIconDesign {
  const words = name.normalize("NFC").match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  const abbreviation = words.length > 1 ? words.map((word) => Array.from(word)[0]).join("") : (words[0] ?? "K8S");
  return {
    label: Array.from(abbreviation.toUpperCase()).slice(0, 3).join(""),
    outlineColor: "#b49aff",
    labelColor: "#b49aff",
    glyph: "network",
    iconColor: "#b49aff",
  };
}

function escapeXml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!,
  );
}

export function clusterIconDataUrl(input: ClusterIconDesign): string {
  const design = normalizeClusterIconDesign(input);
  const glyph = GLYPHS.find((candidate) => candidate.id === design.glyph)!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="15" fill="#292d38" stroke="${design.outlineColor}" stroke-width="3"/><g fill="none" stroke="${design.iconColor}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">${glyph.body}</g><rect x="15" y="46" width="34" height="12" rx="6" fill="${design.labelColor}"/><text x="32" y="55.2" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="9.5" font-weight="800" fill="#292d38">${escapeXml(design.label)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
