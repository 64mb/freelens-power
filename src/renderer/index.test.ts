import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

const localRequire = createRequire(import.meta.url);
function registrations() {
  const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const feature = new Proxy(() => null, { get: () => feature });
  const exports: Record<
    string,
    new () => {
      sanitizedExtensionId: string;
      globalPages: { components: { Page: () => unknown } }[];
      clusterPages: { components: { Page: () => unknown } }[];
      clusterPageMenus: { id?: string }[];
    }
  > = {};
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (["react/jsx-runtime", "mobx-react", "mobx"].includes(name)) return localRequire(name);
      if (name === "@freelensapp/extensions") return { Common: {}, Renderer: { LensExtension: class {} } };
      if (name.endsWith("extension-info"))
        return { EXTENSION_ID: "example-extension", EXTENSION_DISPLAY_NAME: "Example" };
      return feature;
    },
  });
  return new exports.default();
}

it("lets the host wrap every registered page in observer exactly once", () => {
  const extension = registrations();
  const { observer } = localRequire("mobx-react");
  for (const page of [...extension.globalPages, ...extension.clusterPages]) {
    expect(() => observer(page.components.Page)).not.toThrow();
  }
});

it("registers unique sidebar identities while preserving the existing default identity", () => {
  const extension = registrations();
  const identities = extension.clusterPageMenus.map((item) =>
    item.id ? `${extension.sanitizedExtensionId}-${item.id}` : extension.sanitizedExtensionId,
  );
  expect(new Set(identities).size).toBe(identities.length);
  expect(identities[0]).toBe(extension.sanitizedExtensionId);
});
