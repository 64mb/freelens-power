import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { browserScript } from "./build/vite-plugin-browser-script.mjs";
import { standardDecorators } from "./build/vite-plugin-standard-decorators.mjs";

export default defineConfig({
  plugins: [
    // lowers the standard decorators ([@observable accessor]) before Oxc, as in
    // the build; Oxc passes them through and Node cannot run them
    standardDecorators(),
    browserScript(),
    // transforms JSX/TSX the same way the build does, so component tests
    // (e.g. [error-page.test.tsx]) render correctly
    react(),
  ],
  test: {
    // default to a Node environment. Tests that render React components opt into
    // jsdom per-file with a [// @vitest-environment jsdom] comment at the top
    environment: "node",
    // tests import describe, it, expect, vi and the hooks from "vitest"; no
    // tsconfig declares them as globals. [globals] is on at runtime because
    // react Testing Library registers its automatic [afterEach(cleanup)] only
    // when [afterEach] exists as a global
    globals: true,
    exclude: ["integration/**", "node_modules/**", "dist/**"],
    // the same files that [src/tsconfig.json] type-checks and Biome lets
    // import "vitest"
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
    alias: {
      // the host provides [@freelensapp/extensions] on
      // [globalThis.FreelensExtensionApi], and the package is a shim that reads
      // that global when it is imported, so the real package throws in a test
      // tests import a small stub instead - see [test/freelens-extensions.ts]
      // the other host modules (react, mobx, ...) resolve to the
      // devDependencies, which are pinned to the host's versions
      "@freelensapp/extensions": fileURLToPath(new URL("./test/freelens-extensions.ts", import.meta.url)),
    },
  },
});
