// SPDX-License-Identifier: Apache-2.0

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
