/**
 * Email tracking outside the dashboard tab: the CLI command both CLIs share,
 * and the TUI's Email tab with its loader and its on/off key. The API behind
 * them is covered in email-tracking-api.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToScreen } from "@profullstack/hqtui/testing";

import { runEmailTracking, type ApiCall } from "@/lib/emailTracking/cli";
import { createEmailController, EMAIL_TAB, handleKey, initialState, renderBody, TABS } from "@/cli/dashboard";

const ROWS = [
  { project_id: "p-mosh", site: "moshcode.sh", role: "owner", tracking_id: "e960e0a69972a7f34ea197bb", enabled: true, enabled_at: null, tracking_url: "https://crawlproof.com/t/e960e0a69972a7f34ea197bb", events_url: "https://crawlproof.com/api/v1/tracking/e960e0a69972a7f34ea197bb/events", events_24h: { open: 12, click: 3, unsubscribe: 1 } },
  { project_id: "p-pfs", site: "profullstack.com", role: "member", tracking_id: "cf9378b423ec82ad8f896fb7", enabled: false, enabled_at: null, tracking_url: "https://crawlproof.com/t/cf9378b423ec82ad8f896fb7", events_url: "https://crawlproof.com/api/v1/tracking/cf9378b423ec82ad8f896fb7/events", events_24h: { open: 0, click: 0, unsubscribe: 0 } },
];

function capture(isTTY = true) {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: { write: (l: string) => lines.push(l), error: (l: string) => errors.push(l), isTTY } };
}

describe("crawlproof email-tracking", () => {
  const call: ApiCall = vi.fn(async (method, path) => {
    if (method === "GET" && path === "/api/v1/email-tracking") return { status: 200, json: { projects: ROWS } };
    if (method === "GET" && path.startsWith("/api/v1/email-tracking/moshcode.sh")) {
      return { status: 200, json: { ...ROWS[0], ...(path.endsWith("?secret=1") ? { secret: "c17c" } : {}) } };
    }
    if (method === "POST" && path === "/api/v1/email-tracking/profullstack.com/enable") return { status: 200, json: { ...ROWS[1], enabled: true } };
    if (method === "POST" && path === "/api/v1/email-tracking/moshcode.sh/rotate") return { status: 200, json: { ...ROWS[0], secret: "new-secret" } };
    return { status: 404, json: { error: "No such project." } };
  });

  it("lists every project with its state and a day of events", async () => {
    const c = capture();
    expect(await runEmailTracking([], {}, call, c.out)).toBe(0);
    expect(c.lines).toEqual([
      `on   ${"moshcode.sh".padEnd(28)} e960e0a69972a7f34ea197bb  12 opens, 3 clicks, 1 unsubs (24h)`,
      `off  ${"profullstack.com".padEnd(28)} cf9378b423ec82ad8f896fb7  0 opens, 0 clicks, 0 unsubs (24h)`,
    ]);
  });

  it("shows one, with the secret only when asked, and alone when piped", async () => {
    const tty = capture(true);
    await runEmailTracking(["show", "moshcode.sh"], {}, call, tty.out);
    expect(tty.lines.join("\n")).toContain("tracking id  e960e0a69972a7f34ea197bb");
    expect(tty.lines.join("\n")).not.toContain("secret");
    const piped = capture(false);
    await runEmailTracking(["show", "moshcode.sh"], { secret: true }, call, piped.out);
    expect(piped.lines).toEqual(["c17c"]);
  });

  it("enables, rotates, and says what failed", async () => {
    const on = capture();
    expect(await runEmailTracking(["enable", "profullstack.com"], {}, call, on.out)).toBe(0);
    expect(on.lines).toEqual(["profullstack.com: email tracking on (cf9378b423ec82ad8f896fb7)"]);
    const rotated = capture(false);
    await runEmailTracking(["rotate", "moshcode.sh"], {}, call, rotated.out);
    expect(rotated.lines[1]).toBe("new-secret");
    const missing = capture();
    expect(await runEmailTracking(["disable", "nope.dev"], {}, call, missing.out)).toBe(1);
    expect(missing.errors[0]).toBe("email-tracking disable failed: 404 No such project.");
    expect(await runEmailTracking(["enable"], {}, call, capture().out)).toBe(2);
    expect(await runEmailTracking(["frobnicate", "x"], {}, call, capture().out)).toBe(2);
  });
});

describe("the TUI's Email tab", () => {
  it("is a sixth tab that draws without the fleet snapshot", () => {
    expect(TABS[EMAIL_TAB]).toBe("Email");
    const state = initialState({ tab: EMAIL_TAB });
    state.email.rows = ROWS;
    const text = renderToScreen(({ ui, theme }) => renderBody(ui, state, theme), { width: 140, height: 20 }).text();
    for (const want of ["Email tracking", "1 of 2 on", "moshcode.sh", "e960e0a69972a7f34ea197bb", "profullstack.com", "owner"]) expect(text).toContain(want);
    expect(text).not.toContain("Reading the fleet");
  });

  it("loads from the API, and e flips the highlighted project then reloads", async () => {
    const state = initialState({ tab: EMAIL_TAB });
    let enabled = false;
    const api = {
      list: vi.fn(async (base: string, token: string) => {
        expect([base, token]).toEqual(["https://crawlproof.test/", "crp_test"]);
        return [{ ...ROWS[1], enabled }];
      }),
      set: vi.fn(async (_base: string, _token: string, id: string, on: boolean) => {
        expect([id, on]).toEqual(["p-pfs", true]);
        enabled = on;
        return { ...ROWS[1], enabled };
      }),
    };
    const email = createEmailController(state, { baseUrl: "https://crawlproof.test/", token: "crp_test" }, () => {}, api);
    await email.load();
    expect(state.email.rows.map((r) => r.enabled)).toEqual([false]);

    let toggled: Promise<void> | undefined;
    expect(handleKey(state, { name: "e" }, { refresh: () => {}, toggleEmail: (row) => (toggled = email.toggle(row)) })).toBe(true);
    await toggled;
    expect(state.email.rows.map((r) => r.enabled)).toEqual([true]);
    expect(state.email.note).toBe("profullstack.com: email tracking on.");

    state.tab = 0;
    expect(handleKey(state, { name: "e" }, { refresh: () => {}, toggleEmail: () => {} })).toBe(false);
  });
});
