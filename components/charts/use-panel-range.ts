"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TRACKER_RANGE,
  rangesForPanel,
  type TrackerRangeKey,
} from "@/lib/tracker/ranges";
import type { PanelPayload } from "@/lib/tracker/panels";
import { DEFAULT_WHO, WHO_PARAM, type Who } from "@/lib/tracker/who";

// Range state + fetching for one stats card.
//
// The panel starts on whatever the page server-rendered, so the default range
// costs no request at all. Every other range is fetched once and cached for
// the life of the card — flipping back and forth between 1H and 1M is a
// common way to read these charts, and re-querying on each flip makes the
// comparison feel slower than the data it is showing.
//
// `who` is the page-wide Humans / Bots / All toggle. It is part of the cache
// key and of the request, so a card asked for 1H under Humans and then under
// Bots holds both and never shows one side's shape under the other's label.
// `initialData` is only trusted for the (`initialRange`, `who`) it was
// rendered at; the page re-renders with fresh initial data when the toggle
// changes, and remounts the cards so the cache starts over from it.
//
// `projectId` is undefined on the portfolio analytics page, which aggregates
// across every project and drives its own page-wide range control — there is
// no single-project endpoint to ask, so those panels stay on what the server
// rendered and show no tabs.
export function usePanelRange<T extends PanelPayload>(
  projectId: string | undefined,
  panel: string,
  initialData: T,
  initialRange: TrackerRangeKey = DEFAULT_TRACKER_RANGE,
  who: Who = DEFAULT_WHO,
) {
  const ranges = rangesForPanel(panel);
  const [range, setRange] = useState<TrackerRangeKey>(initialRange);
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cache = useRef(
    new Map<string, T>([[cacheKey(who, initialRange), initialData]]),
  );
  // Guards against a slow early request landing after a later one and
  // repainting the card with the range the reader already moved off.
  const latest = useRef(0);

  useEffect(() => {
    if (!projectId) return;

    const cached = cache.current.get(cacheKey(who, range));
    if (cached) {
      setData(cached);
      setError(null);
      setLoading(false);
      return;
    }

    const seq = ++latest.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(panelUrl(projectId, panel, range, who), {
          signal: controller.signal,
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        const payload = body?.panels?.[panel] as T | undefined;
        if (payload === undefined) throw new Error("Panel missing from response.");
        cache.current.set(cacheKey(who, range), payload);
        if (seq === latest.current) {
          setData(payload);
          setLoading(false);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (seq !== latest.current) return;
        setError(err instanceof Error ? err.message : "Could not load range.");
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [projectId, panel, range, who]);

  const changeRange = useCallback((key: TrackerRangeKey) => setRange(key), []);

  return {
    ranges,
    range,
    setRange: changeRange,
    data,
    loading,
    error,
    // Tabs are meaningless without an endpoint to switch against.
    showTabs: !!projectId,
  };
}

function cacheKey(who: Who, range: TrackerRangeKey) {
  return `${who}:${range}`;
}

/** The request one card makes for one (range, who). Exported for tests. */
export function panelUrl(
  projectId: string,
  panel: string,
  range: TrackerRangeKey,
  who: Who,
) {
  const params = new URLSearchParams({ range, panel, [WHO_PARAM]: who });
  return `/api/projects/${projectId}/tracker-stats?${params.toString()}`;
}
