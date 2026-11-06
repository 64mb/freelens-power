// SPDX-License-Identifier: Apache-2.0

import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { formatDateTime } from "../../common/date-time";
import { ipcRenderer } from "../ipc";

import type { SecretCertificate } from "../../common/secret-certificates";

const { DrawerTitle, DrawerItem } = Renderer.Component;

export const SecretCertificateDetails = observer(
  ({ object }: Renderer.Component.KubeObjectDetailsProps<Renderer.K8sApi.Secret>) => {
    const serializedData = JSON.stringify(object.data ?? {});
    const [certificates, setCertificates] = useState<SecretCertificate[]>([]);
    useEffect(() => {
      let active = true;
      setCertificates([]);
      void ipcRenderer.invoke("freelens-power:secret-certificates", JSON.parse(serializedData)).then(
        (parsed: SecretCertificate[]) => {
          if (active) setCertificates(parsed);
        },
        () => {
          if (active) setCertificates([]);
        },
      );
      return () => {
        active = false;
      };
    }, [serializedData]);
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
              <DrawerItem name="Not before">
                <span style={{ whiteSpace: "pre-wrap" }}>{formatDateTime(certificate.validFrom)}</span>
              </DrawerItem>
              <DrawerItem name="Expires">
                <span style={expired ? { color: "red" } : undefined}>
                  <span style={{ whiteSpace: "pre-wrap" }}>{formatDateTime(certificate.validTo)}</span> (
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
