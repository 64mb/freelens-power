import { describe, expect, it } from "vitest";
import {
  clusterIconDataUrl,
  clusterIconDesignFromDataUrl,
  defaultClusterIconDesign,
  GLYPHS,
  normalizeClusterIconDesign,
} from "./cluster-icons";

const design = defaultClusterIconDesign("demo cluster");

describe("cluster icon design", () => {
  it("offers fifteen distinct whitelisted glyphs and renders each selection", () => {
    expect(GLYPHS).toHaveLength(15);
    expect(new Set(GLYPHS.map((glyph) => glyph.id)).size).toBe(15);
    const generated = GLYPHS.map((glyph) => {
      expect(normalizeClusterIconDesign({ ...design, glyph: glyph.id }).glyph).toBe(glyph.id);
      const url = clusterIconDataUrl({ ...design, glyph: glyph.id });
      expect(decodeURIComponent(url.split(",")[1])).toContain(glyph.body);
      return url;
    });
    expect(new Set(generated).size).toBe(15);
    expect(() => clusterIconDataUrl({ ...design, glyph: "unlisted" })).toThrow();
  });

  it("derives editable Unicode initials without splitting surrogate pairs", () => {
    expect(design.label).toBe("DC");
    expect(defaultClusterIconDesign("example").label).toBe("EXA");
    expect(defaultClusterIconDesign("δοκιμή περιβάλλον").label).toBe("ΔΠ");
    expect(defaultClusterIconDesign("").label).toBe("K8S");
    expect(normalizeClusterIconDesign({ ...design, label: "e\u0301中" }).label).toBe("é中");
  });

  it("accepts independent colors and strips unrelated properties", () => {
    expect(
      normalizeClusterIconDesign({
        ...design,
        outlineColor: "#ABCDEF",
        labelColor: "#123456",
        iconColor: "#654321",
        extra: "ignored",
      }),
    ).toEqual({ ...design, outlineColor: "#abcdef", labelColor: "#123456", iconColor: "#654321" });
  });

  it("rejects untrusted SVG, colors, control characters and oversized labels", () => {
    for (const input of [
      null,
      [],
      { ...design, glyph: "<script/>" },
      { ...design, iconColor: 'red" onload="alert(1)' },
      { ...design, labelColor: "url(https://example.invalid)" },
      { ...design, label: "ABCD" },
      { ...design, label: "A\u0000" },
      { ...design, label: "A\u202e" },
    ]) {
      expect(() => normalizeClusterIconDesign(input)).toThrow();
    }
  });

  it("escapes labels and emits only fixed local glyph geometry", () => {
    for (const glyph of GLYPHS) {
      const url = clusterIconDataUrl({ ...design, glyph: glyph.id, label: '<&"' });
      const svg = decodeURIComponent(url.split(",")[1]);
      expect(svg).toContain("&lt;&amp;&quot;");
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg).toContain('y="46" width="34" height="12"');
      expect(svg).not.toMatch(/<script|onload|href=/);
    }
  });
});

it("recovers all legacy editor glyphs and distinct saved colors from URI and base64 SVGs", () => {
  for (const glyph of GLYPHS) {
    const previous = {
      ...design,
      glyph: glyph.id,
      outlineColor: "#fa1234",
      iconColor: "#12ab34",
      labelColor: "#3456ef",
    };
    const url = clusterIconDataUrl(previous);
    expect(clusterIconDesignFromDataUrl(url)).toEqual(previous);
    const svg = decodeURIComponent(url.split(",")[1]);
    const merged = svg
      .replace(
        /<g fill="none" stroke="([^"]+)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><g transform="([^"]+)" stroke-width="([^"]+)">/,
        '<g transform="$2" fill="none" stroke="$1" stroke-width="$3" stroke-linecap="round" stroke-linejoin="round">',
      )
      .replace("</g></g>", "</g>")
      .replace('stroke-width="2.972602739"', 'stroke-width="2.972602740"');
    expect(clusterIconDesignFromDataUrl(`data:image/svg+xml;base64,${Buffer.from(merged).toString("base64")}`)).toEqual(
      previous,
    );
    expect(clusterIconDesignFromDataUrl(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)).toEqual(
      previous,
    );
    expect(clusterIconDesignFromDataUrl(url.replace("%3C%2Fsvg%3E", "%3Cscript%2F%3E%3C%2Fsvg%3E"))).toBeUndefined();
  }
  expect(clusterIconDesignFromDataUrl("data:image/png;base64,AQID")).toBeUndefined();
  expect(clusterIconDesignFromDataUrl("#123456")).toBeUndefined();
});
