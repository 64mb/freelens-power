import { BrowserWindow, type IpcMainInvokeEvent, shell } from "electron";
import { powerIpc } from "./power-ipc";
import { parseSecretCertificates, validateCertificateData } from "./secret-certificates";

function trustedRenderer(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || !frame || frame.detached) return false;
  try {
    const url = new URL(frame.url);
    const root = new URL(event.sender.getURL());
    if (
      url.protocol !== "https:" ||
      root.protocol !== "https:" ||
      url.port !== root.port ||
      url.username ||
      url.password
    )
      return false;
    if (url.hostname !== "renderer.freelens.app" && !/^[a-z0-9-]+\.renderer\.freelens\.app$/.test(url.hostname))
      return false;
    return frame === event.sender.mainFrame
      ? url.origin === root.origin
      : root.hostname === "renderer.freelens.app" &&
          frame.parent === event.sender.mainFrame &&
          frame.top === event.sender.mainFrame;
  } catch {
    return false;
  }
}

export function startRendererServices(): () => void {
  powerIpc.handle("freelens-power:secret-certificates", (event, input: unknown) => {
    if (!trustedRenderer(event)) throw new Error("Untrusted renderer");
    return parseSecretCertificates(validateCertificateData(input));
  });
  powerIpc.handle("freelens-power:open-external", async (event, input: unknown) => {
    if (!trustedRenderer(event) || typeof input !== "string" || input.length > 8192)
      throw new Error("Invalid external URL");
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid external URL");
    await shell.openExternal(url.href);
  });
  return () => {
    powerIpc.removeHandler("freelens-power:secret-certificates");
    powerIpc.removeHandler("freelens-power:open-external");
  };
}
