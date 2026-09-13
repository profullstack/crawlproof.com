import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToScreen } from "@profullstack/hqtui/testing";
import { ADS_TIMEOUT_MS, collectAds, collectDashboard, type DashboardSnapshot, type FeedProgress } from "@/lib/dashboard/collect";
import { createRefreshController, handleKey, initialState, renderBody, renderFetchStatus } from "@/cli/dashboard";
import { buildRoi } from "@/lib/dashboard/roi";

const ads = { rangeDays: 7, statsUnavailable: false, totals: { pubImpressions: 12345, pubClicks: 83 } };
const options = { baseUrl: "https://crawlproof.test", token: "test", range: "1w", who: "humans", financeDays: 7, coinpay: null };
const snapshot = (): DashboardSnapshot => ({
  generatedAt: "2026-09-13T10:00:00.000Z",
  window: { range: "1w", who: "humans", financeDays: 7 },
  sites: [], fleet: { sources: [], pages: [], referrers: [] }, ads, finance: null, errors: {},
  roi: buildRoi({ traffic: { range: "1w", who: "humans", sites: [] }, ads, finance: null }),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ads retries", () => {
  it("allows a healthy 25-second ads response to finish", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, init) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(ads)), 25000);
      init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
    }));
    vi.stubGlobal("fetch", fetcher);
    const result = collectAds(options.baseUrl, "test", 7);
    await vi.advanceTimersByTimeAsync(25000);
    expect(await result).toEqual(ads);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a timeout once and reports the attempt visibly", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }))
      .mockResolvedValueOnce(Response.json(ads));
    vi.stubGlobal("fetch", fetcher);
    const progress: FeedProgress[] = [];
    const result = collectAds(options.baseUrl, "test", 7, (value) => progress.push(value));
    await vi.advanceTimersByTimeAsync(ADS_TIMEOUT_MS + 1000);
    expect(await result).toEqual(ads);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(progress).toContainEqual({ status: "retrying", detail: "Ads retry 2/2" });
  });

  it("retries partial data and transient HTTP errors, but not an invalid token", async () => {
    vi.useFakeTimers();
    for (const first of [Response.json({ ...ads, statsUnavailable: true }), Response.json({ error: "busy" }, { status: 503 })]) {
      const fetcher = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(Response.json(ads));
      vi.stubGlobal("fetch", fetcher);
      const result = collectAds(options.baseUrl, "test", 7);
      await vi.runAllTimersAsync();
      expect(await result).toEqual(ads);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: "Invalid token" }, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(collectAds(options.baseUrl, "test", 7)).rejects.toThrow("Invalid token");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("failed ads refresh", () => {
  it("retains the last successful response and timestamp only for the same window", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/sites")
      ? Response.json({ sites: [] })
      : Response.json({ error: "upstream unavailable" }, { status: 503 })));
    const previous = snapshot();
    for (const financeDays of [7, 30]) {
      const pending = collectDashboard({ ...options, financeDays, previous });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.errors.ads).toBe("upstream unavailable");
      if (financeDays === 7) {
        expect(result.ads).toEqual(ads);
        expect(result.adsStale).toBe(true);
        expect(result.adsUpdatedAt).toBe(previous.generatedAt);
        const state = initialState({ tab: 2, snapshot: result });
        const screen = renderToScreen(({ ui, theme }) => renderBody(ui, state, theme), { width: 140, height: 40 });
        expect(screen.text()).toContain("Ads: saved data from 2026-09-13T10:00:00.000Z");
        expect(screen.text()).toContain("12,345");
      } else {
        expect(result.ads).toBeNull();
        expect(result.adsStale).toBe(false);
      }
    }
  });
});

describe("visible refresh lifecycle", () => {
  it("r immediately starts animated feed spinners and then shows success", async () => {
    const state = initialState({ tab: 2, snapshot: snapshot() });
    let finish!: (value: DashboardSnapshot) => void;
    const collector = vi.fn<typeof collectDashboard>(() => new Promise((resolve) => { finish = resolve; }));
    const refresh = createRefreshController(state, options, vi.fn(), collector);
    handleKey(state, { name: "r" }, { refresh });
    expect(state.loading).toBe(true);
    const draw = (elapsed: number) => renderToScreen(({ ui, theme }) => renderFetchStatus(ui, state, theme), { width: 120, height: 4, elapsed }).text();
    expect(draw(0)).toContain("Fetching traffic");
    expect(draw(0)).toContain("Fetching ads");
    expect(draw(0)).toContain("Fetching CoinPay");
    expect(draw(0)).toContain("Refreshing…");
    expect(draw(0)).not.toEqual(draw(80));
    for (const feed of ["traffic", "ads", "finance"] as const) {
      collector.mock.calls[0]![0].onProgress?.(feed, { status: "success", detail: `${feed} refreshed` });
    }
    finish(snapshot());
    await vi.waitFor(() => expect(state.loading).toBe(false));
    expect(state.refreshMessage).toContain("Refresh complete");
    expect(draw(0)).toEqual(draw(80));
  });

  it("queues repeated r presses once and applies a changed window", async () => {
    const state = initialState({ range: "1w" });
    let finish!: (value: DashboardSnapshot) => void;
    const collector = vi.fn<typeof collectDashboard>()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue(snapshot());
    const refresh = createRefreshController(state, options, vi.fn(), collector);
    const running = refresh();
    state.range = "1m";
    void refresh();
    void refresh();
    expect(state.refreshQueued).toBe(true);
    expect(collector).toHaveBeenCalledTimes(1);
    const text = renderToScreen(({ ui, theme }) => renderFetchStatus(ui, state, theme), { width: 120, height: 4 }).text();
    expect(text).toContain("next refresh queued");
    finish(snapshot());
    await running;
    expect(collector).toHaveBeenCalledTimes(2);
    expect(collector.mock.calls[1]![0].financeDays).toBe(30);
    expect(state.loading).toBe(false);
    expect(state.refreshQueued).toBe(false);
  });

  it("stops spinners and shows a failure instead of pretending the refresh worked", async () => {
    const previous = snapshot();
    const state = initialState({ snapshot: previous });
    const collector = vi.fn<typeof collectDashboard>().mockRejectedValue(new Error("network down"));
    await createRefreshController(state, options, vi.fn(), collector)();
    expect(state.snapshot).toBe(previous);
    expect(state.loading).toBe(false);
    expect(state.refreshMessage).toBe("Refresh failed: network down · r retries");
    expect(Object.values(state.feeds).every((feed) => feed.status === "error")).toBe(true);
  });
});
