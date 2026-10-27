import { ipcRenderer } from "electron";
import { useEffect, useMemo, useRef, useState } from "react";
import { HELM_CHANNEL, type HelmReleaseMetadata, type HelmRequest, type HelmResponse } from "../common/helm";

export type HelmVersion = { appVersion?: string; chartVersion?: string };
export type HelmVersionResult = { value: HelmVersion } | { error: string };
type Listener = (result: HelmVersionResult) => void;
type Job = {
  key: string;
  request: HelmRequest;
  listeners: Set<Listener>;
  started: boolean;
  cancelled: boolean;
  settled: boolean;
  priority: "visible" | "background";
  backgroundSlot: boolean;
  notBefore: number;
  refreshTag?: string;
};
const cache = new Map<string, { value: HelmVersion; expires: number }>();
const jobs = new Map<string, Job>();
const successfulReads = new Set<(key: string, value: HelmVersion, refreshTag?: string) => void>();
const queue: Job[] = [];
const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let sequence = 0;
let running = 0;
let backgroundRunning = 0;
let backgroundAfter = 0;
let wakeTimer: ReturnType<typeof setTimeout> | undefined;

function cached(key: string) {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  if (entry.expires <= Date.now()) return;
  cache.set(key, entry);
  return entry.value;
}
function pump() {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
  }
  while (running < 2 && queue.length) {
    const visibleIndex = queue.findIndex((job) => job.priority === "visible");
    const index = visibleIndex >= 0 ? visibleIndex : backgroundRunning < 1 ? 0 : -1;
    if (index < 0) return;
    const candidate = queue[index];
    const delay = candidate.priority === "background" ? Math.max(candidate.notBefore, backgroundAfter) - Date.now() : 0;
    if (delay > 0) {
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        pump();
      }, delay);
      return;
    }
    const job = queue.splice(index, 1)[0];
    if (job.cancelled) continue;
    job.started = true;
    running++;
    job.backgroundSlot = job.priority === "background";
    if (job.backgroundSlot) {
      backgroundRunning++;
      backgroundAfter = Date.now() + 200;
    }
    void Promise.resolve()
      .then(() =>
        job.cancelled ? undefined : (ipcRenderer.invoke(HELM_CHANNEL, job.request) as Promise<HelmResponse>),
      )
      .then((response) => {
        if (job.cancelled || !response) return;
        job.settled = true;
        if (jobs.get(job.key) !== job) {
          for (const listener of job.listeners)
            listener({ error: "A newer application version request replaced this read." });
          return;
        }
        let result: HelmVersionResult;
        if (!response.ok) result = { error: response.error.message };
        else if (response.contextId !== job.request.contextId)
          result = { error: "Cluster context changed. Retry to load the application version." };
        else {
          const text = (value: unknown) =>
            typeof value === "string" && new TextEncoder().encode(value).byteLength <= 1024 ? value : undefined;
          const value = { appVersion: text(response.appVersion), chartVersion: text(response.chartVersion) };
          if (jobs.get(job.key) === job) {
            cache.delete(job.key);
            cache.set(job.key, { value, expires: Date.now() + 5 * 60_000 });
            while (cache.size > 1000) cache.delete(cache.keys().next().value as string);
            for (const notify of successfulReads) notify(job.key, value, job.refreshTag);
          }
          result = { value };
        }
        for (const listener of job.listeners) listener(result);
      })
      .catch(() => {
        job.settled = true;
        if (!job.cancelled)
          for (const listener of job.listeners)
            listener({ error: "Unable to load the application version. Retry to try again." });
      })
      .finally(() => {
        running--;
        if (job.backgroundSlot) backgroundRunning--;
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        pump();
      });
  }
}
export function subscribeHelmVersion(
  key: string,
  request: HelmRequest,
  refresh: boolean,
  listener: Listener,
  priority: "visible" | "background" = "visible",
  refreshTag?: string,
) {
  const value = refresh ? undefined : cached(key);
  if (value) {
    listener({ value });
    return () => undefined;
  }
  if (refresh) cache.delete(key);
  let job = jobs.get(key);
  if (job?.settled || (refresh && job && (!job.request.refresh || job.refreshTag !== refreshTag))) job = undefined;
  if (!job) {
    job = {
      key,
      request: { ...request, refresh },
      listeners: new Set(),
      started: false,
      cancelled: false,
      settled: false,
      priority,
      backgroundSlot: false,
      notBefore: Date.now() + (priority === "background" ? 200 : 0),
      refreshTag,
    };
    jobs.set(key, job);
    queue.push(job);
  }
  if (priority === "visible") job.priority = "visible";
  job.listeners.add(listener);
  pump();
  const subscribedJob = job;
  return () => {
    subscribedJob.listeners.delete(listener);
    if (subscribedJob.listeners.size || subscribedJob.cancelled || subscribedJob.settled) return;
    subscribedJob.cancelled = true;
    if (jobs.get(key) === subscribedJob) jobs.delete(key);
    if (subscribedJob.started) {
      void ipcRenderer.invoke(HELM_CHANNEL, { ...subscribedJob.request, operation: "cancel" }).catch(() => undefined);
    } else {
      const index = queue.indexOf(subscribedJob);
      if (index >= 0) queue.splice(index, 1);
      pump();
    }
  };
}

export function helmVersionIdentity(clusterId: string, contextId: string, release: HelmReleaseMetadata) {
  return JSON.stringify([clusterId, contextId, release.namespace, release.name, release.revision, release.uid]);
}
export function nextHelmVersionRequestId() {
  return `app-version-${session}-${++sequence}`;
}

type IndexGeneration = {
  identity: string;
  refresh: boolean;
  versions: Map<string, HelmVersion>;
  failed: Set<string>;
};

export function useHelmVersionIndex({
  clusterId,
  contextId,
  releases,
  active = true,
  refreshToken,
}: {
  clusterId: string;
  contextId: string;
  releases: readonly HelmReleaseMetadata[];
  active?: boolean;
  refreshToken?: string | number;
}) {
  const identity = JSON.stringify([clusterId, contextId, refreshToken]);
  const entries = useMemo(
    () => [
      ...new Map(
        releases.slice(0, 20_000).map((release) => [helmVersionIdentity(clusterId, contextId, release), release]),
      ).entries(),
    ],
    [clusterId, contextId, releases],
  );
  const dataset = JSON.stringify(entries.map(([key]) => key));
  const generation = useRef<IndexGeneration>();
  const previous = useRef({ clusterId, contextId, refreshToken });
  const [snapshot, setSnapshot] = useState<{
    identity: string;
    versions: Map<string, HelmVersion>;
    failed: Set<string>;
  }>();
  useEffect(() => {
    if (generation.current?.identity !== identity) {
      const refresh =
        previous.current.clusterId === clusterId &&
        previous.current.contextId === contextId &&
        previous.current.refreshToken !== refreshToken;
      generation.current = { identity, refresh, versions: new Map(), failed: new Set() };
      previous.current = { clusterId, contextId, refreshToken };
    }
    const current = generation.current!;
    const keys = new Set(entries.map(([key]) => key));
    current.versions = new Map([...current.versions].filter(([key]) => keys.has(key)));
    current.failed = new Set([...current.failed].filter((key) => keys.has(key)));
    let stopped = false;
    let cancelCurrent: (() => void) | undefined;
    let publication: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (publication) clearTimeout(publication);
      publication = undefined;
      if (!stopped) setSnapshot({ identity, versions: new Map(current.versions), failed: new Set(current.failed) });
    };
    const schedulePublication = () => {
      if (!publication) publication = setTimeout(publish, 16);
    };
    const onSuccessfulRead = (key: string, value: HelmVersion, refreshTag?: string) => {
      if (stopped || !keys.has(key)) return;
      const sameGeneration = refreshTag === identity || refreshTag?.startsWith(`${identity}:retry:`);
      if (current.refresh && !sameGeneration && !current.failed.has(key)) return;
      current.versions.set(key, value);
      current.failed.delete(key);
      schedulePublication();
    };
    successfulReads.add(onSuccessfulRead);
    publish();
    if (active)
      void (async () => {
        let sinceYield = 0;
        for (const [key, release] of entries) {
          if (stopped) return;
          if (current.versions.has(key) || current.failed.has(key)) continue;
          const result = await new Promise<HelmVersionResult>((resolve) => {
            cancelCurrent = subscribeHelmVersion(
              key,
              {
                requestId: nextHelmVersionRequestId(),
                clusterId,
                contextId,
                namespace: release.namespace,
                name: release.name,
                revision: release.revision,
                uid: release.uid,
                operation: "app-version",
              },
              current.refresh,
              resolve,
              "background",
              current.identity,
            );
          });
          cancelCurrent?.();
          cancelCurrent = undefined;
          if (stopped) return;
          if ("value" in result) {
            current.versions.set(key, result.value);
            current.failed.delete(key);
          } else if (!current.versions.has(key)) current.failed.add(key);
          schedulePublication();
          if (++sinceYield >= 25) {
            sinceYield = 0;
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        publish();
      })();
    return () => {
      stopped = true;
      if (publication) clearTimeout(publication);
      successfulReads.delete(onSuccessfulRead);
      cancelCurrent?.();
    };
  }, [identity, dataset, active]);
  const versions = useMemo(() => {
    const known = snapshot?.identity === identity ? snapshot.versions : undefined;
    return new Map(entries.flatMap(([key]) => (known?.has(key) ? [[key, known.get(key)!] as const] : [])));
  }, [snapshot, identity, dataset]);
  const errors = snapshot?.identity === identity ? entries.filter(([key]) => snapshot.failed.has(key)).length : 0;
  const total = entries.length;
  const completed = versions.size + errors;
  return {
    versions: versions as ReadonlyMap<string, HelmVersion>,
    versionFor: (release: HelmReleaseMetadata) => versions.get(helmVersionIdentity(clusterId, contextId, release)),
    completed,
    total,
    errors,
    loading: active && completed < total,
    paused: !active && completed < total,
    truncated: releases.length > 20_000,
  };
}
