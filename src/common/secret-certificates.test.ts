// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseSecretCertificates } from "./secret-certificates";

const certificate = `-----BEGIN CERTIFICATE-----
MIIDKDCCAhCgAwIBAgIJAK93OMQ4k0dkMA0GCSqGSIb3DQEBCwUAMDcxFjAUBgNV
BAoMDUZyZWVsZW5zIFRlc3QxHTAbBgNVBAMMFHNlcnZpY2UuZXhhbXBsZS50ZXN0
MB4XDTI2MTAyMDIzMjQwNVoXDTI2MTExOTIzMjQwNVowNzEWMBQGA1UECgwNRnJl
ZWxlbnMgVGVzdDEdMBsGA1UEAwwUc2VydmljZS5leGFtcGxlLnRlc3QwggEiMA0G
CSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDKZ7krLRI5p0DKI0B0x17KtVA+QYWQ
iFD+10yByqkIdFXJeQQkpl3tX3+zpIzrjBVUEi6aqxUqGWH4b2vKU3kYinbRVvOu
vqltVhZuEBLvUTmSwztJoX4JJYqC3iXcCUCwDu+rZNRahtt0sn5RZtcGe2FuccSq
JjgI5I9tNcAEl6ZviA1aekE3bfkvWbZJZEp8MocqC64ncz81e9h0hd79oUzIzC+w
mBv+MJMaJFQxmOuNcppLg63C4Ch3hymtQj744cxf+ltVMKNs9w2ylXtSm6FJJ6Tp
PcspQMe7Oq6x6r8gBDUW8GP5im7Gv077f4hcPJ4fV4rbrnAMO0QdqHhNAgMBAAGj
NzA1MDMGA1UdEQQsMCqCFHNlcnZpY2UuZXhhbXBsZS50ZXN0ghJvdGhlci5leGFt
cGxlLnRlc3QwDQYJKoZIhvcNAQELBQADggEBAIdxzFL+FgQvU1HjT4WPCVUAHsYW
YH/kRRfztIlGOtvLykN3sjuKAcPTmJ0o16HpmvxsHHTgLc95FMuFnxid8nf1nacZ
OgK2HwsdIHTL6vYGykETWWvFM/K8js/cBCGT0OeK4DJ3wNmQnYZTk3tYbtZwBGD1
/2zo5GF6gbYU+Wg3c2SWDA31eCSU/1F0AAWAOURWPcUXQ6L7XWXU5wLhB6O5m4mj
xPGbR7qdtJkBHh9F2D40agrrDSOeOt/M78TAhczVGrOSdNh0pWSVqvYrRPPv1S19
l/YSjptyvkNIxQ8QDfSNde2jeVkv0OPWZsQq08WvcWJCKwqVFOLtqvQ6T3Y=
-----END CERTIFICATE-----`;
const withoutCommonName = `-----BEGIN CERTIFICATE-----
MIICrDCCAZQCCQCHI/Yb6epsfDANBgkqhkiG9w0BAQsFADAYMRYwFAYDVQQKDA1G
cmVlbGVucyBUZXN0MB4XDTI2MTAyMDIzMjQwNVoXDTI2MTExOTIzMjQwNVowGDEW
MBQGA1UECgwNRnJlZWxlbnMgVGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBAKuVyDkNct3xwomkcl7F8/uyRtfhldmjy3T0RH/RMy8PH42lRU5XJCKp
rIpfta576PoxH8GVq0N92JOsIgp/fcs844FMkFCTHI4bp8ED1bFCvoyhg+5XmkbR
1jAUTzJYOXNHGgu+xKKownQRTVgGBrc15gwxpc5aie0Xg+9S7GUPijbqP/IfMA9s
rnHXZxlQJaxQAt1rfJoY6B0xxKYlf3zlE44wl6Oq4a7J+1DHtQ0wtHNx6x2qSSgE
czStifbNMLV1BtdZP55DfgCrALoTGqF5DotGlYQXlCJq9uI8VVHBb3Zbra+8Yx/6
Q7pCXhjiJzu0gKIjz77geNTfzVvG0eMCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEA
KyTobL6xhfS6iIcqh206s/MUxRuPiXOLbNa//iMG0TAfsutgXRWXZUl8qUE/k6tl
3HE+ek5smFfwGZvm5D7TPIArj7QzkoAvIBCncTYd+2BkYFlhN1MQC42XcupL3YVu
e95InzxRGKH9VNtWj92IV07MCFPaNOtRt6MOI/B7oESLkMFL89TUb5xDDjjdTjYI
Htzs6D+WXPfBm2GcuD2AfnJHVv1aIR0yME4yyZQ4cJISf4+giOPwl4CWghhuKeBh
p18By2MDSzEqrkjSNc+fK4ZjPZaC3j2lOwBtI/i3GlAYtadCuJQSiiFy6elQPlbo
7lTFAmyMEw+zTqLcqh8nXA==
-----END CERTIFICATE-----`;
const encode = (value: string) => Buffer.from(value).toString("base64");

describe("parseSecretCertificates", () => {
  it("extracts certificate metadata without returning PEM contents", () => {
    const [parsed] = parseSecretCertificates({ "tls.crt": encode(certificate) });

    expect(parsed).toMatchObject({
      key: "tls.crt",
      index: 1,
      commonName: "service.example.test",
      issuer: "service.example.test",
      subjectAltName: "DNS:service.example.test, DNS:other.example.test",
    });
    expect(parsed.serialNumber).toMatch(/^[0-9A-F]+$/);
    expect(new Date(parsed.validTo).getTime() - new Date(parsed.validFrom).getTime()).toBe(30 * 86_400_000);
    expect(JSON.stringify(parsed)).not.toContain("BEGIN CERTIFICATE");
  });

  it("reads every certificate in bundles and every secret key", () => {
    const parsed = parseSecretCertificates({
      bundle: encode(`${certificate}\n${certificate}`),
      extra: encode(certificate),
    });

    expect(parsed.map(({ key, index }) => [key, index])).toEqual([
      ["bundle", 1],
      ["bundle", 2],
      ["extra", 1],
    ]);
  });

  it("recovers after malformed and unterminated certificate blocks", () => {
    const broken = "-----BEGIN CERTIFICATE-----broken-----END CERTIFICATE-----";
    const unterminated = "-----BEGIN CERTIFICATE-----broken";
    const parsed = parseSecretCertificates({
      bundle: encode(`${broken}\n${certificate}\n${unterminated}\n${certificate}`),
    });

    expect(parsed).toHaveLength(2);
    expect(parsed.every(({ commonName }) => commonName === "service.example.test")).toBe(true);
  });

  it("falls back to the subject and issuer when CN is absent", () => {
    const [parsed] = parseSecretCertificates({ cert: encode(withoutCommonName) });

    expect(parsed.commonName).toBe("O=Freelens Test");
    expect(parsed.issuer).toBe("O=Freelens Test");
    expect(parsed.subjectAltName).toBeUndefined();
  });

  it("ignores empty data, arbitrary values, and private keys", () => {
    expect(parseSecretCertificates()).toEqual([]);
    expect(
      parseSecretCertificates({
        empty: "",
        invalid: "not base64",
        "tls.key": encode("-----BEGIN PRIVATE KEY-----private material-----END PRIVATE KEY-----"),
      }),
    ).toEqual([]);
  });
});
