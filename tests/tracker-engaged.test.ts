import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/stats.js/route";
import {
  ENGAGED_EVENT,
  ENGAGED_SINCE,
  engagedFromBeacon,
  engagedPartial,
  engagedRate,
  engagedRateLabel,
  nextEngaged,
} from "@/lib/tracker/engaged";
import { ACTIVE_USERS_DEFINITION, ACTIVE_USERS_LABEL } from "@/lib/tracker/humans";
import { applyScriptedDemotion, parseVisitorTouch } from "@/lib/tracker/scripted";
import { toVisitorTotals } from "@/lib/tracker/visitors";
import { mergeTotals } from "@/lib/tracker/apiStats";
import { headlineTiles } from "@/lib/tracker/who";

describe("engaged categorization", () => {
  it("only the engaged beacon from the human side marks a visitor", () => {
    expect(engagedFromBeacon(ENGAGED_EVENT, "human")).toBe(true);
    expect(engagedFromBeacon(ENGAGED_EVENT, "bot")).toBe(false);
    expect(engagedFromBeacon("pageview", "human")).toBe(false);
    expect(engagedFromBeacon("scroll_25", "human")).toBe(false);
  });

  it("is sticky for the day while human, and cleared when the row becomes a bot", () => {
    expect(nextEngaged(false, true, "human")).toBe(true);
    expect(nextEngaged(true, false, "human")).toBe(true);
    expect(nextEngaged(false, false, "human")).toBe(false);
    expect(nextEngaged(true, false, "bot")).toBe(false);
    expect(nextEngaged(false, true, "bot")).toBe(false);
  });

  it("an engaged beacon from a visitor demoted by the scripted cap never counts", () => {
    const touch = parseVisitorTouch({ kind: "bot", events: 501, pageviews: 3, engaged: true });
    expect(touch?.engaged).toBe(false);
    expect(applyScriptedDemotion("human:direct", touch).kind).toBe("bot");
  });

  it("reads the engaged flag the touch RPC returns, false when absent (pre-migration)", () => {
    expect(parseVisitorTouch([{ kind: "human", events: 2, pageviews: 1, engaged: true }])?.engaged).toBe(true);
    expect(parseVisitorTouch([{ kind: "human", events: 2, pageviews: 1 }])?.engaged).toBe(false);
  });
});

describe("active rate", () => {
  it("is a one-decimal share of human visitors, null without visitors", () => {
    expect(engagedRate(268, 234_792)).toBe(0.1);
    expect(engagedRate(1, 8)).toBe(12.5);
    expect(engagedRate(0, 0)).toBeNull();
    expect(engagedRate(null, 10)).toBeNull();
    // Never above 100%, whatever the inputs say.
    expect(engagedRate(12, 10)).toBe(100);
    expect(engagedRateLabel(1, 8)).toBe("Active rate 12.5%");
  });

  it("knows when a window starts before the beacon existed", () => {
    const day = new Date(`${ENGAGED_SINCE}T12:00:00Z`);
    expect(engagedPartial(1, day)).toBe(false);
    expect(engagedPartial(2, day)).toBe(true);
  });
});

describe("rollup readers", () => {
  it("carries engaged and prev_engaged, 0 before the migration adds them", () => {
    const t = toVisitorTotals({
      project_id: "p",
      visitors: "234792",
      prev_visitors: "0",
      pageviews: "240000",
      prev_pageviews: "0",
      engaged: "268",
      prev_engaged: null,
    });
    expect(t.engaged).toBe(268);
    expect(t.prevEngaged).toBe(0);
    const old = toVisitorTotals({ project_id: "p", visitors: 3, prev_visitors: 0, pageviews: 3, prev_pageviews: 0 });
    expect(old.engaged).toBe(0);
  });

  it("API totals: engaged is null with the rollup, never 0", () => {
    expect(mergeTotals({ events: 9, pageviews: 3 }, null).engaged).toBeNull();
    expect(mergeTotals({ events: 9, pageviews: 3 }, { visitors: 4, pageviews: 3, engaged: 1 }).engaged).toBe(1);
  });
});

describe("headline tiles", () => {
  it("shows Active users with the active rate next to Human visitors", () => {
    const tiles = headlineTiles("humans", { visitors: 40, pageviews: 50, engaged: 10, humans: 200, ai: 1, bots: 9 });
    expect(tiles.map((t) => t.key)).toEqual(["visitors", "engaged", "pageviews", "humans", "ai"]);
    const active = tiles[1];
    expect(active.label).toBe(ACTIVE_USERS_LABEL);
    expect(active.label).toBe("Active users");
    expect(active.hint).toBe(ACTIVE_USERS_DEFINITION);
    expect(active.sub).toBe("Active rate 25%");
  });

  it("never shows Active users on the Bots view or without the rollup", () => {
    const bots = headlineTiles("bots", { visitors: 40, pageviews: 50, engaged: 0, humans: 0, ai: 0, bots: 9 });
    expect(bots.some((t) => t.key === "engaged")).toBe(false);
    const none = headlineTiles("humans", { visitors: 40, pageviews: 50, engaged: null, humans: 1, ai: 0, bots: 0 });
    expect(none.some((t) => t.key === "engaged")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stats.js in a minimal browser stand-in: which beacons it actually sends.
// ---------------------------------------------------------------------------

type Listener = (e: unknown) => void;

async function bootStats(opts: { webdriver?: boolean; focused?: boolean } = {}) {
  const script = await (await GET()).text();
  const sent: string[] = [];
  const listeners: Record<string, Listener[]> = {};
  const intervals: (() => void)[] = [];
  const store = new Map<string, string>();
  const on = (type: string, fn: Listener) => {
    (listeners[type] ??= []).push(fn);
  };
  const location = {
    href: "https://example.com/a",
    origin: "https://example.com",
    pathname: "/a",
    search: "",
    hash: "",
    hostname: "example.com",
  };
  const document = {
    currentScript: { dataset: { site: "00000000-0000-4000-8000-000000000001" }, src: "https://crawlproof.com/stats.js" },
    readyState: "complete",
    referrer: "",
    visibilityState: "visible",
    hasFocus: () => opts.focused ?? true,
    addEventListener: on,
    querySelector: () => null,
    getElementsByTagName: () => [],
    documentElement: { scrollHeight: 1000 },
  };
  const win: Record<string, unknown> = {
    document,
    location,
    navigator: { language: "en", webdriver: opts.webdriver ?? false },
    history: { state: null, pushState() {}, replaceState() {} },
    screen: { width: 1, height: 1 },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    addEventListener: on,
    innerWidth: 1,
    innerHeight: 1,
    scrollY: 0,
    setInterval: (fn: () => void) => intervals.push(fn),
    clearInterval: (id: number) => {
      intervals[id - 1] = () => {};
    },
    fetch: (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body).type);
      return Promise.resolve({ ok: false });
    },
    URL,
    Intl,
    crypto: globalThis.crypto,
  };
  win.window = win;
  vm.runInNewContext(script, win);
  const fire = (type: string, isTrusted = true) => {
    for (const fn of listeners[type] ?? []) fn({ type, isTrusted, target: null });
  };
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) for (const fn of [...intervals]) fn();
  };
  return { sent, fire, tick };
}

describe("stats.js engaged beacon", () => {
  it("sends one engaged beacon on trusted input, after the page view", async () => {
    const page = await bootStats();
    expect(page.sent).toEqual(["pageview"]);
    page.fire("pointerdown");
    page.fire("keydown");
    page.fire("wheel");
    expect(page.sent).toEqual(["pageview", "engaged"]);
  });

  it("ignores synthetic (untrusted) input", async () => {
    const page = await bootStats({ focused: false });
    page.fire("pointerdown", false);
    page.fire("touchstart", false);
    expect(page.sent).toEqual(["pageview"]);
  });

  it("sends after 10s visible and focused, not before, and only once", async () => {
    const page = await bootStats();
    page.tick(9);
    expect(page.sent).toEqual(["pageview"]);
    page.tick(30);
    expect(page.sent).toEqual(["pageview", "engaged"]);
  });

  it("does not count time on an unfocused page", async () => {
    const page = await bootStats({ focused: false });
    page.tick(60);
    expect(page.sent).toEqual(["pageview"]);
  });

  it("never fires for a browser that says it is automated", async () => {
    const page = await bootStats({ webdriver: true });
    page.fire("pointerdown");
    page.tick(60);
    expect(page.sent).toEqual(["pageview"]);
  });
});
