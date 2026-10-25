export const COMMON_RESOURCE_KINDS = [
  "Pod",
  "Deployment",
  "Service",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "Ingress",
  "Gateway",
  "HTTPRoute",
  "ConfigMap",
  "Secret",
  "Namespace",
  "Node",
  "PersistentVolumeClaim",
  "PersistentVolume",
];

export function resourceKindPriority(kind: string): number {
  const index = COMMON_RESOURCE_KINDS.indexOf(kind);
  return index < 0 ? COMMON_RESOURCE_KINDS.length : index;
}
