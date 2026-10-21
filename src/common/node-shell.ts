import { isIP } from "node:net";

export function selectNodeAddress(
  addresses: { type: string; address: string }[],
  preferIPv6: boolean,
): string | undefined {
  const families = preferIPv6 ? [6, 4] : [4, 6];

  for (const family of families) {
    for (const type of ["InternalIP", "ExternalIP"]) {
      const match = addresses.find((entry) => entry.type === type && isIP(entry.address) === family);

      if (match) return match.address;
    }
  }

  return undefined;
}

export function buildNodeShellCommand(command: string, address: string): string {
  if (!isIP(address)) {
    throw new Error("Node address must be a valid IP literal");
  }

  const prefix = command.trim() || "ssh";
  const quotedAddress = `'${address.replace(/'/g, "'\\''")}'`;

  return `${prefix} ${quotedAddress}`;
}

export function isColimaNode(contextName: string | undefined, nodeName: string, hostname: string | undefined): boolean {
  return contextName === "colima" && nodeName === "colima" && hostname === "colima";
}
