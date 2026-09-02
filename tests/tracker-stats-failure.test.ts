import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcFailed, type Loaded } from "@/lib/loaded";

// The portfolio dashboard reported "0 pageviews" on every project while the
// tracker was writing a row a second. dashboard_project_pageviews was being
// cancelled by the 8s statement_timeout and returning HTTP 500, and the loader
// read only `data` -- `const { data } = await supabase.rpc(...)` -- so a
// cancelled query and a genuinely quiet week produced byte-identical output.
//
// This is the fourth time zeros-on-failure has been diagnosed from scratch on
// this product (#199, #225, #226, and this). The point of these tests is that
// "we could not read this" can never again be indistinguishable from "this is 0".

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rpcFailed", () => {
  it("reports no failure when the RPC returned no error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(rpcFailed("tracker", "dashboard_project_pageviews", null)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a failure and logs it, so the cause is not only in Postgres' logs", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = rpcFailed("tracker", "dashboard_project_pageviews", {
      message: "canceling statement due to statement timeout",
    });
    expect(failed).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("dashboard_project_pageviews");
    expect(String(spy.mock.calls[0][0])).toContain("statement timeout");
  });

  it("still reports a failure when the error carries no message", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(rpcFailed("tracker", "tracker_top_pages_multi", {})).toBe(true);
  });

  it("scopes the log line, so ad and tracker failures are tellable apart", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcFailed("ads", "ad_campaign_totals", { message: "boom" });
    rpcFailed("tracker", "tracker_event_mix_multi", { message: "boom" });
    expect(String(spy.mock.calls[0][0])).toContain("[ads]");
    expect(String(spy.mock.calls[1][0])).toContain("[tracker]");
  });
});

describe("a zero-filled Loaded result", () => {
  // The zero-fill itself is deliberate and stays: one dead panel must not take
  // the page down. What `failed` buys is that the renderer can tell the two
  // apart and say "not zero -- missing" instead of drawing a confident 0.
  const emptied = (failed: boolean): Loaded<Map<string, number>> => ({
    data: new Map([["project-a", 0]]),
    failed,
  });

  it("looks identical in its data whether it failed or was genuinely quiet", () => {
    expect(emptied(true).data).toEqual(emptied(false).data);
  });

  it("is only distinguishable by the flag", () => {
    expect(emptied(true).failed).toBe(true);
    expect(emptied(false).failed).toBe(false);
  });
});
