// SPDX-License-Identifier: Apache-2.0

import { X509Certificate } from "node:crypto";

export interface SecretCertificate {
  key: string;
  index: number;
  commonName: string;
  subjectAltName: string | undefined;
  serialNumber: string;
  issuer: string;
  validFrom: string;
  validTo: string;
}

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
