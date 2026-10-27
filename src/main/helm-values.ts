import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helmValuesValidationError } from "../common/helm-values-validation";
import { HelmError } from "./helm";

export function validateHelmValues(values: unknown): asserts values is string {
  const error = typeof values === "string" ? helmValuesValidationError(values) : "Values must be YAML text";
  if (error) throw new HelmError("invalid-values", error);
}
export function chartChoices(output: string, name: string, version: string): Array<{ ref: string; version: string }> {
  let rows: unknown;
  try {
    rows = JSON.parse(output);
  } catch {
    throw new HelmError("chart-unavailable", "Helm repository search is unavailable");
  }
  if (!Array.isArray(rows)) throw new HelmError("chart-unavailable", "Helm repository search is unavailable");
  return [
    ...new Set(
      rows
        .filter(
          (row) =>
            row &&
            row.version === version &&
            typeof row.name === "string" &&
            /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(row.name) &&
            row.name.split("/")[1] === name,
        )
        .map((row) => row.name),
    ),
  ].map((ref) => ({ ref, version }));
}
export async function withHelmValues<T>(values: string, action: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "freelens-helm-values-"));
  try {
    const path = join(directory, "values.yaml");
    await writeFile(path, values, { mode: 0o600, flag: "wx" });
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
