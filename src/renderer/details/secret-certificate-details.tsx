// SPDX-License-Identifier: Apache-2.0

import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { parseSecretCertificates } from "../../common/secret-certificates";

const { DrawerTitle, DrawerItem } = Renderer.Component;

export const SecretCertificateDetails = observer(
  ({ object }: Renderer.Component.KubeObjectDetailsProps<Renderer.K8sApi.Secret>) => {
    const certificates = parseSecretCertificates(object.data);
    const now = Date.now();

    if (certificates.length === 0) return null;

    return (
      <>
        {certificates.map((certificate) => {
          const remaining = new Date(certificate.validTo).getTime() - now;
          const days = Math.ceil(remaining / 86_400_000);
          const expired = remaining <= 0;

          return (
            <div key={`${certificate.key}:${certificate.index}`}>
              <DrawerTitle>
                Certificate Info - {certificate.key} ({certificate.index})
              </DrawerTitle>
              <DrawerItem name="CN">{certificate.commonName}</DrawerItem>
              <DrawerItem name="SAN">{certificate.subjectAltName ?? "—"}</DrawerItem>
              <DrawerItem name="Serial Number">{certificate.serialNumber}</DrawerItem>
              <DrawerItem name="Issuer">{certificate.issuer}</DrawerItem>
              <DrawerItem name="Not before">{certificate.validFrom}</DrawerItem>
              <DrawerItem name="Expires">
                <span style={expired ? { color: "red" } : undefined}>
                  {certificate.validTo} (
                  {expired ? `Expired ${Math.ceil(-remaining / 86_400_000)} days ago` : `${days} days remaining`})
                </span>
              </DrawerItem>
            </div>
          );
        })}
      </>
    );
  },
);
