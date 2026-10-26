import { redactSearchIndexText } from "../common/search-index-redaction";

export interface SearchField {
  label: string;
  text: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, 32) : []);
export function projectSearchFields(kind: string, value: unknown): SearchField[] {
  if (kind === "Secret" || kind === "ConfigMap") return [];
  const object = record(value);
  const status = record(object.status);
  const spec = record(object.spec);
  const metadata = record(object.metadata);
  const fields: SearchField[] = [];
  let remaining = 4096;
  const add = (label: string, value: unknown, redact = false) => {
    if (typeof value !== "string" || !remaining || fields.length >= 32) return;
    const bounded = value.slice(0, 4096);
    const text = (redact ? redactSearchIndexText(bounded) : bounded).slice(0, Math.min(512, remaining));
    if (text) {
      fields.push({ label, text });
      remaining -= text.length;
    }
  };
  add("Phase", status.phase);
  for (const condition of array(status.conditions)) {
    const item = record(condition);
    add("Condition", item.type);
    add("Reason", item.reason, true);
    add("Message", item.message, true);
  }
  const template = record(record(spec.template).spec);
  for (const container of [...array(spec.containers), ...array(template.containers)]) {
    const item = record(container);
    add("Container", item.name);
    add("Image", item.image);
  }
  const selector = record(spec.selector);
  for (const [key, value] of Object.entries({ ...selector, ...record(selector.matchLabels) }).slice(0, 32)) {
    if (typeof value === "string") add("Selector", `${key}=${value}`);
  }
  const target = record(spec.scaleTargetRef);
  add("Scale target", target.kind);
  add("Scale target", target.name);
  for (const owner of array(metadata.ownerReferences)) {
    add("Owner kind", record(owner).kind);
    add("Owner", record(owner).name);
  }
  return fields;
}
