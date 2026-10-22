// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { app, type NativeImage, nativeImage } from "electron";
import { reaction } from "mobx";
import { AppearancePreferencesStore, isAccentSelection } from "../common/store/appearance-preferences-store";

// the bitmap uses premultiplied BGRA channels on macOS
export function recolorIconBitmap(bitmap: Buffer, color: string): Buffer {
  const result = Buffer.from(bitmap);
  const target = [5, 3, 1].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  for (let index = 0; index < result.length; index += 4) {
    const blue = bitmap[index];
    const green = bitmap[index + 1];
    const red = bitmap[index + 2];
    const alpha = bitmap[index + 3];
    // select saturated teal, preserving white logo pixels, neutral shadows and alpha
    if (!alpha || green <= red * 1.3 || blue <= red * 1.3 || Math.abs(green - blue) > Math.max(green, blue) * 0.4) {
      continue;
    }
    // normalize against the original [#23a49c] artwork so its flat fill matches the selected accent
    const brightness = Math.max(green, blue) / 164;
    for (let channel = 0; channel < 3; channel++) {
      result[index + channel] = Math.min(alpha, Math.round(target[channel] * brightness));
    }
  }
  return result;
}

export async function loadOriginalIcon(): Promise<NativeImage> {
  // macOS composes the app's frame and padding outside the raw [icon.icns] artwork
  const bundle = join(dirname(app.getPath("exe")), "..", "..");
  if (!bundle.endsWith(".app")) throw new Error("app bundle unavailable");
  const directory = await mkdtemp(join(app.getPath("temp"), "freelens-power-icon-"));
  try {
    const converted = join(directory, "icon.png");
    await promisify(execFile)(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `
      ObjC.import("AppKit");
      function run(argv) {
        var icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
        var rendered = $.NSImage.alloc.initWithSize($.NSMakeSize(512, 512));
        rendered.lockFocus;
        icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 512, 512), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
        rendered.unlockFocus;
        var bitmap = $.NSBitmapImageRep.imageRepWithData(rendered.TIFFRepresentation);
        if (!bitmap.representationUsingTypeProperties($.NSPNGFileType, $({})).writeToFileAtomically(argv[1], true)) {
          throw new Error("could not render app icon");
        }
      }
    `,
        bundle,
        converted,
      ],
      { timeout: 10_000 },
    );
    const original = nativeImage.createFromPath(converted);
    if (original.isEmpty()) throw new Error("empty app icon");
    const bitmap = original.toBitmap();
    if (recolorIconBitmap(bitmap, "#7060e8").equals(bitmap)) throw new Error("app icon colors unavailable");
    return original;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function startDockIconOverride(): () => void {
  if (process.platform !== "darwin" || !app.dock) return () => {};
  const dock = app.dock;
  const preferences = AppearancePreferencesStore.getInstanceOrCreate<AppearancePreferencesStore>();
  const cache = new Map<string, NativeImage>();
  let original: NativeImage | undefined;
  let pending: Promise<NativeImage> | undefined;
  let disposed = false;
  let revision = 0;
  let overridden = false;

  const restore = () => {
    if (overridden && original) {
      dock.setIcon(original);
      overridden = false;
    }
  };
  const stop = reaction(
    () => [preferences.enabled, preferences.accentColor, preferences.recolorAppIcon] as const,
    ([enabled, color, recolorAppIcon]) => {
      const request = ++revision;
      if (!enabled || !recolorAppIcon || color === "default" || !isAccentSelection(color)) {
        restore();
        return;
      }
      pending ??= loadOriginalIcon();
      void pending
        .then((source) => {
          original = source;
          if (disposed || revision !== request) return;
          let tinted = cache.get(color);
          if (!tinted) {
            const size = source.getSize();
            tinted = nativeImage.createFromBitmap(recolorIconBitmap(source.toBitmap(), color), size);
            cache.set(color, tinted);
          }
          dock.setIcon(tinted);
          overridden = true;
        })
        .catch(() => {
          pending = undefined;
          console.warn("[freelens-power] Could not update the Dock icon");
        });
    },
    { fireImmediately: true },
  );
  return () => {
    disposed = true;
    revision++;
    stop();
    restore();
  };
}
