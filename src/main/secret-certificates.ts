// SPDX-License-Identifier: Apache-2.0

import { X509Certificate } from "node:crypto";

import type { SecretCertificate } from "../common/secret-certificates";

function commonName(distinguishedName: string): string {
  return /^CN=(.*)$/m.exec(distinguishedName)?.[1] ?? distinguishedName;
}

export function parseSecretCertificates(data: Partial<Record<string, string>> = {}): SecretCertificate[] {
  const certificates: SecretCertificate[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string") continue;

    const decoded = Buffer.from(value, "base64").toString("utf8");
    const blocks = decoded.matchAll(
      /-----BEGIN CERTIFICATE-----((?:(?!-----BEGIN CERTIFICATE-----)[\s\S])*?)-----END CERTIFICATE-----/g,
    );
    let index = 0;

    for (const [pem] of blocks) {
      index += 1;

      try {
        const certificate = new X509Certificate(pem);

        certificates.push({
          key,
          index,
          commonName: commonName(certificate.subject),
          subjectAltName: certificate.subjectAltName,
          serialNumber: certificate.serialNumber,
          issuer: commonName(certificate.issuer),
          validFrom: certificate.validFrom,
          validTo: certificate.validTo,
        });
      } catch {
        // malformed certificate blocks must not hide other certificates
      }
    }
  }

  return certificates;
}

export function validateCertificateData(input: unknown): Partial<Record<string, string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid certificate data");
  const entries = Object.entries(input);
  if (entries.length > 256) throw new Error("Too many certificate entries");
  let bytes = 0;
  for (const [key, value] of entries) {
    if (key.length > 1024 || typeof value !== "string") throw new Error("Invalid certificate entry");
    bytes += Buffer.byteLength(value);
    if (bytes > 4 * 1024 * 1024) throw new Error("Certificate data exceeds the safety limit");
  }
  return Object.fromEntries(entries);
}
