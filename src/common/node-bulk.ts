export const NODE_BULK_CHANNEL = "freelens-power:node-bulk";
export const NODE_BULK_LIMIT = 100;
export type NodeBulkAction = "cordon" | "uncordon" | "drain";
export interface NodeBulkTarget {
  name: string;
  uid: string;
}
export type NodeBulkStatus = "running" | "succeeded" | "failed" | "cancelled";
export interface NodeBulkJob {
  id: string;
  clusterId: string;
  contextId: string;
  action: NodeBulkAction;
  status: NodeBulkStatus;
  nodes: (NodeBulkTarget & { status: NodeBulkStatus | "pending" | "skipped"; message?: string })[];
  startedAt: number;
  finishedAt?: number;
}
export interface NodeBulkRequest {
  operation: "context" | "begin" | "status" | "cancel";
  clusterId: string;
  contextId?: string;
  jobId?: string;
  action?: NodeBulkAction;
  nodes?: NodeBulkTarget[];
  confirmed?: boolean;
}
export interface NodeBulkResponse {
  ok: boolean;
  contextId?: string;
  job?: NodeBulkJob;
  error?: { code: string; message: string };
}
