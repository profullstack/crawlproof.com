"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TRACKER_RANGE,
  rangesForPanel,
  type TrackerRangeKey,
} from "@/lib/tracker/ranges";
import type { PanelPayload } from "@/lib/tracker/panels";

// Range state + fetching for one stats card.
//
// The panel starts on whatever the page server-rendered, so the default range
// costs no request at all. Every other range is fetched once and cached for
// the life of the card — flipping back and forth between 1H and 1M is a
// common way to read these charts, and re-querying on each flip makes the
// comparison feel slower than the data it is showing.
// `projectId` is undefined on the portfolio analytics page, which aggregates
// across every project and drives its own page-wide range control — there is
// no single-project endpoint to ask, so those panels stay on what the server
// rendered and show no tabs.
export function usePanelRange<T extends PanelPayload>(
  projectId: string | undefined,
  panel: string,
  initialData: T,
  initialRange: TrackerRangeKey = DEFAULT_TRACKER_RANGE,
) {
  const ranges = rangesForPanel(panel);
  const [range, setRange] = useState<TrackerRangeKey>(initialRange);
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cache = useRef(new Map<TrackerRangeKey, T>([[initialRange, initialData]]));
  // Guards against a slow early request landing after a later one and
  // repainting the card with the range the reader already moved off.
  const latest = useRef(0);

  useEffect(() => {
    if (!projectId) return;

    const cached = cache.current.get(range);
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
        const res = await fetch(
          `/api/projects/${projectId}/tracker-stats?range=${range}&panel=${panel}`,
          { signal: controller.signal },
        );
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        const payload = body?.panels?.[panel] as T | undefined;
        if (payload === undefined) throw new Error("Panel missing from response.");
        cache.current.set(range, payload);
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
  }, [projectId, panel, range]);

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
