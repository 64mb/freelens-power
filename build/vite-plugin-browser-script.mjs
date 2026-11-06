import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

/** @returns {import("vite").Plugin} */
export function browserScript() {
  return {
    name: "browser-script",
    enforce: "pre",
    async load(id) {
      if (!id.endsWith("?browser-script")) return null;
      const filename = id.slice(0, -"?browser-script".length);
      this.addWatchFile(filename);
      const result = await transform(await readFile(filename, "utf8"), {
        loader: "ts",
        target: "esnext",
      });
      // serialized helpers are self-contained functions executed in an isolated document
      const source = result.code.replace(/export\s*\{[^}]*\};?\s*$/, "").replace(/^export /gm, "");
      return `export default ${JSON.stringify(source)};`;
    },
  };
}
