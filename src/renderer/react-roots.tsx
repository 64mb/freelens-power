import { observable, runInAction } from "mobx";
import { observer } from "mobx-react";
import { createPortal } from "react-dom";
import { ExtensionBoundary } from "./extension-boundary";

import type { ReactNode } from "react";

const containers = observable.map<Element, { node: ReactNode; key: string }>([], { deep: false });
let nextKey = 0;

export function renderIntoContainer(node: ReactNode, container: Element): void {
  runInAction(() => {
    containers.set(container, { node, key: containers.get(container)?.key ?? String(nextKey++) });
  });
}

export function unmountContainer(container: Element): void {
  runInAction(() => {
    containers.delete(container);
  });
}

export function clearRenderedContainers(): void {
  runInAction(() => {
    containers.clear();
  });
}

export const PortalHost = observer(() => (
  <>
    {Array.from(containers, ([container, { node, key }]) =>
      createPortal(<ExtensionBoundary>{node}</ExtensionBoundary>, container, key),
    )}
  </>
));
