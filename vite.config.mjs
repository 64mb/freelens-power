import { browserScript } from "./build/vite-plugin-browser-script.mjs";
/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// builds the extension's two entry points, one per run: the renderer with
// [vite build], the main entry with [vite build --mode main]. The renderer runs
// in a browser page and main in Node, so they cannot share settings, and each
// bundle carries its own copy of [src/common/] rather than a chunk the other
// process would have to load

import { builtinModules, isBuiltin } from "node:module";
import react from "@vitejs/plugin-react";
import { defaultServerConditions, defaultServerMainFields, defineConfig } from "vite";
import { cssModuleDeclarations } from "./build/vite-plugin-css-module-declarations.mjs";
import { hostModules } from "./build/vite-plugin-host-modules.mjs";
import { standardDecorators } from "./build/vite-plugin-standard-decorators.mjs";

const entryPoints = {
  renderer: {
    entry: "src/renderer/index.tsx",
    // first of the two runs in [build], so it clears the output directory
    // [dev] turns this off: in watch mode Vite empties the directory again on
    // every rebuild, which would delete the main entry
    emptyOutDir: true,
    // renderer code gets no guarantee of Node or Electron, so nothing is left
    // for the runtime to resolve
    external: [],
    platform: /** @type {const} */ ("browser"),
  },
  main: {
    entry: "src/main/index.ts",
    emptyOutDir: false,
    // node and Electron resolve their own modules at runtime
    external: ["electron", /^electron\//, /^node:/, ...builtinModules],
    // bundled CommonJS packages [require()] the builtins. For the browser
    // platform Rolldown turns such a call into a shim that throws in an ES
    // module, where there is no [require]; for Node it creates one with
    // [createRequire(import.meta.url)]
    platform: /** @type {const} */ ("node"),
  },
};

/**
 * Fails the renderer build on an import of Node or Electron. Vite would replace
 * a builtin with an empty module and only warn, so the import would be
 * `undefined` when the extension runs.
 *
 * @type {import("vite").Plugin}
 */
const noNodeInRenderer = {
  name: "no-node-in-renderer",
  enforce: "pre",
  resolveId(source, importer) {
    if (isBuiltin(source) || source === "electron" || source.startsWith("electron/")) {
      this.error(`"${source}" is imported by ${importer}, but renderer code gets no Node or Electron`);
    }
    return null;
  },
};

export default defineConfig(({ mode }) => {
  const name = mode === "preload" ? "preload" : mode === "main" ? "main" : "renderer";
  const entryPoint =
    name === "preload"
      ? {
          entry: "src/preload/dashboard-preload.ts",
          emptyOutDir: false,
          external: [],
          platform: /** @type {const} */ ("browser"),
        }
      : entryPoints[name];

  return {
    plugins: [
      // oxc, which transpiles TypeScript for Vite, passes standard decorators
      // through unlowered, and neither Node nor Chromium runs them yet
      standardDecorators(),
      browserScript(),
      hostModules(name === "preload" ? "renderer" : name),
      // jSX with the automatic runtime, so it imports [react/jsx-runtime]
      react(),
      // the committed [*.module.d.scss.ts] declarations of the CSS modules
      ...(name === "renderer" ? [noNodeInRenderer, cssModuleDeclarations()] : []),
    ],
    css: {
      modules: {
        localsConvention: "camelCaseOnly",
      },
    },
    ...(name === "renderer"
      ? {
          // library mode leaves [process.env.NODE_ENV] for a consumer's
          // bundler to replace, but the bundle is loaded as it is, by a page
          // with no [process]
          define: { "process.env.NODE_ENV": JSON.stringify("production") },
        }
      : {
          // main runs in Node: pick the Node builds of bundled packages, not
          // their browser builds
          resolve: { conditions: [...defaultServerConditions], mainFields: [...defaultServerMainFields] },
          // a bundled CommonJS package reads [__dirname] and [__filename],
          // which Node passes to a CommonJS module and an ES module does not
          // have; Rolldown leaves them as they are
          define: { __dirname: "import.meta.dirname", __filename: "import.meta.filename" },
        }),
    build: {
      target: "esnext",
      minify: false,
      sourcemap: true,
      emptyOutDir: entryPoint.emptyOutDir,
      lib: {
        entry:
          name === "main"
            ? {
                main: entryPoint.entry,
                "power-logs-child": "src/main/power-logs-child.ts",
                "power-logs-query-child": "src/main/power-logs-query-child.ts",
                "power-logs-database": "src/main/power-logs-database.ts",
                "power-logs-query": "src/main/power-logs-query.ts",
                "ai-codex-api": "src/main/ai-codex-api.ts",
              }
            : entryPoint.entry,
        formats: ["es"],
        fileName: (_format, entryName) =>
          name === "preload" ? "dashboard-preload.cjs" : `${name === "main" ? entryName : name}.js`,
        // the host links [<entry>.css] next to the renderer entry. Library
        // mode extracts the CSS of the whole bundle into this one file
        cssFileName: name,
      },
      rolldownOptions: {
        external: entryPoint.external,
        platform: entryPoint.platform,
      },
    },
  };
});
