import { vi } from "vitest";

export function stubMainFrame(main: boolean): void {
  const target = window;
  const frame: Window = new Proxy(target, {
    get(object, property) {
      return property === "top" ? (main ? frame : {}) : Reflect.get(object, property, object);
    },
  });
  vi.stubGlobal("window", frame);
}
