import { MetricChart } from "./monitoring";
import { type HistoryRange, MonitoringHistoryRange } from "./monitoring-history-view";

import type { MonitoringSample } from "../common/monitoring-math";

export function MonitoringDetailsChart({
  metric,
  samples,
  status,
  historyStatus,
  range,
  onRangeChange,
  native = false,
  scope,
}: {
  metric: "cpu" | "memory";
  samples: MonitoringSample[];
  status: string;
  historyStatus: string;
  range: HistoryRange;
  onRangeChange(value: HistoryRange): void;
  native?: boolean;
  scope?: "node" | "pod";
}) {
  return (
    <div className="power-details-metric-chart">
      <style>{`
      .power-details-metric-chart .power-monitoring-period-action { position:absolute;top:19px;right:16px;left:auto }
      .power-details-metric-chart [data-monitoring-heading] { overflow-wrap:anywhere }
    `}</style>
      <MetricChart
        metric={metric}
        samples={samples}
        status={status}
        scope={scope}
        headerAction={<MonitoringHistoryRange compact native={native} range={range} onChange={onRangeChange} />}
      />
      {historyStatus && (
        <small
          role="status"
          style={{
            display: "block",
            padding: "0 16px 8px",
            color: "var(--textColorSecondary)",
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {historyStatus}
        </small>
      )}
    </div>
  );
}
