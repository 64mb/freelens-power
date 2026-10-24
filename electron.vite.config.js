import { builtinModules } from "node:module";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { globalExternals } from "./build/global-externals.js";

// keep modules provided by the host runtime external because [rolldownOptions]
// replaces the default [rollupOptions.external] from [electron-vite]
const runtimeExternals = ["electron", /^electron\//, ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export default defineConfig({
  // main process has full access to Node.js APIs
  main: {
    build: {
      emptyOutDir: true,
      lib: {
        entry: {
          index: resolve(__dirname, "src/main/index.ts"),
          "dashboard-preload": resolve(__dirname, "src/main/dashboard-preload.ts"),
          "power-logs-child": resolve(__dirname, "src/main/power-logs-child.ts"),
          "power-logs-query-child": resolve(__dirname, "src/main/power-logs-query-child.ts"),
        },
        // freelens 1.xx extensions are CommonJS modules
        formats: ["cjs"],
      },
      rolldownOptions: {
        external: runtimeExternals,
        output: {
          // silence warning about using [chunk.default] to access the default export
          exports: "named",
          // prefer separate files for each module
          preserveModules: (process.env.VITE_PRESERVE_MODULES ?? "true") === "true",
          preserveModulesRoot: "src/main",
        },
      },
      sourcemap: true,
    },
    oxc: {
      decorator: {
        legacy: true,
        emitDecoratorMetadata: true,
      },
    },
    plugins: [
      react({
        babel: {
          plugins: [
            [
              "@babel/plugin-proposal-decorators",
              {
                version: "2023-05",
              },
            ],
          ],
        },
      }),
      globalExternals({
        // the modules are provided by the host app as a global variable
        "@freelensapp/extensions": "global.LensExtensions",
        mobx: "global.Mobx",
      }),
    ],
  },
  // renderer process in Freelens can use Node.js modules then it is configured
  // with settings for preload script
  preload: {
    build: {
      emptyOutDir: true,
      lib: {
        entry: resolve(__dirname, "src/renderer/index.tsx"),
        // freelens 1.xx extensions are CommonJS modules
        formats: ["cjs"],
      },
      outDir: "out/renderer",
      rolldownOptions: {
        external: runtimeExternals,
        output: {
          // silence warning about using [chunk.default] to access the default export
          exports: "named",
          // prefer separate files for each module
          preserveModules: (process.env.VITE_PRESERVE_MODULES ?? "true") === "true",
          preserveModulesRoot: "src/renderer",
        },
      },
      sourcemap: true,
    },
    oxc: {
      decorator: {
        legacy: true,
        emitDecoratorMetadata: true,
      },
    },
    plugins: [
      react({
        babel: {
          plugins: [
            [
              "@babel/plugin-proposal-decorators",
              {
                version: "2023-05",
              },
            ],
          ],
        },
      }),
      globalExternals({
        // the modules are provided by the host app as a global variable
        "@freelensapp/extensions": "global.LensExtensions",
        mobx: "global.Mobx",
        "mobx-react": "global.MobxReact",
        react: "global.React",
        "react-dom": "global.ReactDOM",
        "react-router-dom": "global.ReactRouterDom",
        "react/jsx-runtime": "global.ReactJsxRuntime",
      }),
    ],
  },
});
