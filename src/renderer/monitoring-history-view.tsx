import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { useEffect, useState } from "react";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import { monitoringHistory } from "./monitoring-history";

import type { HistoryIdentity, HistoryPoint } from "../common/monitoring-history";
import type { MonitoringSample } from "../common/monitoring-math";
export const HISTORY_RANGES = { "30m": 1_800_000, "2h": 7_200_000, "24h": 86_400_000, "7d": 604_800_000 } as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;
export function mergeHistorySamples(
  points: HistoryPoint[],
  live: MonitoringSample[],
  from: number,
): MonitoringSample[] {
  const buckets = new Map<number, MonitoringSample>();
  for (const point of points) {
    if (point.time < from) continue;
    const sample = buckets.get(point.time) ?? { time: point.time, cpu: NaN, memory: NaN };
    if (point.metric === "cpu" || point.metric === "memory") {
      sample[point.metric] = point.avg;
      sample.historical ??= {};
      sample.historical[point.metric] = {
        min: point.min,
        max: point.max,
        count: point.count,
        resolution: point.resolution,
        gap: point.gap,
      };
      if (point.gap) sample.breakBefore = true;
    } else if (point.metric !== "restarts") {
      const match = /^(cpu|memory)(Requests|Limits|Capacity|Allocatable)$/.exec(point.metric);
      if (match) {
        sample.resources ??= { cpu: {}, memory: {} };
        sample.resources[match[1] as "cpu" | "memory"][
          match[2].toLowerCase() as "requests" | "limits" | "capacity" | "allocatable"
        ] = point.avg;
      }
    }
    if (point.gap) sample.resourceStatus = "Partial historical bucket; missing samples are gaps";
    buckets.set(point.time, sample);
  }
  for (const sample of live)
    if (sample.time >= from) {
      for (const point of points)
        if (sample.time >= point.time && sample.time < point.time + point.resolution) buckets.delete(point.time);
      buckets.set(sample.time, sample);
    }
  const samples = [...buckets.values()]
    .filter((sample) => Number.isFinite(sample.cpu) && Number.isFinite(sample.memory))
    .sort((a, b) => a.time - b.time);
  const resolution = (sample: MonitoringSample) =>
    Math.max(sample.historical?.cpu?.resolution ?? 30_000, sample.historical?.memory?.resolution ?? 30_000);
  return samples.map((sample, index) =>
    index > 0 &&
    sample.time - samples[index - 1].time > 1.8 * Math.max(resolution(sample), resolution(samples[index - 1]))
      ? { ...sample, breakBefore: true }
      : sample,
  );
}
export function useMonitoringHistory(identity: HistoryIdentity | undefined, liveSamples: MonitoringSample[]) {
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  const [enabled, setEnabled] = useState(preferences.historyEnabled === true);
  useEffect(
    () => reaction(() => preferences.historyEnabled === true, setEnabled, { fireImmediately: true }),
    [preferences],
  );
  const [range, setRange] = useState<HistoryRange>("30m");
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [status, setStatus] = useState("");
  const key = identity ? `${identity.clusterId}/${identity.scope}/${identity.uid}` : "";
  useEffect(() => {
    let current = true;
    setPoints([]);
    setStatus("");
    if (!identity || !enabled) return;
    const query = () => {
      const to = Date.now();
      void Promise.resolve()
        .then(() => monitoringHistory.query({ ...identity, from: to - HISTORY_RANGES[range] + 1000, to }))
        .then((value) => {
          if (current) {
            setPoints(value);
            setStatus(
              value.length
                ? "Historical averages; min/max available in stored buckets"
                : "No local history for this range. Collection starts when enabled.",
            );
          }
        })
        .catch(() => {
          if (current) setStatus("Local history unavailable. Live samples remain visible.");
        });
    };
    query();
    const timer = window.setInterval(query, 30_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [key, range, enabled]);
  return {
    range,
    setRange,
    samples: mergeHistorySamples(points, liveSamples, Date.now() - HISTORY_RANGES[range]),
    points,
    status,
  };
}
export function MonitoringHistoryRange({
  range,
  onChange,
  native = false,
}: {
  range: HistoryRange;
  onChange: (value: HistoryRange) => void;
  // host [Select] requires injected context unavailable in detached chart roots
  native?: boolean;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      History range
      <span style={{ width: 120 }}>
        {native ? (
          <Renderer.Component.Select
            aria-label="History range"
            value={range}
            options={Object.keys(HISTORY_RANGES).map((value) => ({ value: value as HistoryRange, label: value }))}
            onChange={(option) => {
              if (option) onChange(option.value);
            }}
            isClearable={false}
          />
        ) : (
          <select
            aria-label="History range"
            value={range}
            onChange={(event) => onChange(event.target.value as HistoryRange)}
            style={{
              width: "100%",
              padding: "6px 8px",
              color: "var(--textColorPrimary)",
              background: "var(--contentColor)",
              border: "1px solid var(--borderColor)",
              borderRadius: 4,
            }}
          >
            {Object.keys(HISTORY_RANGES).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
      </span>
    </label>
  );
}
