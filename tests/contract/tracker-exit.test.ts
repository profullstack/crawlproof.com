import { describe, expect, it } from "vitest";
import { updateExitRollup } from "@/lib/tracker/exit";

// Minimal in-memory fake of the two tables the exit rollup touches, exposing
// just the subset of the Supabase query builder the module uses. It records
// exit counts and per-session last-page state so we can assert the "exit
// marker moves as the session advances" behavior end to end.
function makeFakeSb() {
  const exits = new Map<string, { project: string; day: string; page: string; count: number }>();
  const sessions = new Map<string, { project: string; session: string; last_page_path: string; last_day: string }>();
  const key = (...parts: string[]) => parts.join("|");

  function table(name: string) {
    const filters: Record<string, string> = {};
    let pending: Record<string, unknown> | null = null; // insert/update payload
    let op: "select" | "insert" | "update" | "delete" = "select";

    const chain: Record<string, unknown> = {
      select() { op = "select"; return chain; },
      insert(row: Record<string, unknown>) { op = "insert"; pending = row; return exec(); },
      update(row: Record<string, unknown>) { op = "update"; pending = row; return chain; },
      delete() { op = "delete"; return chain; },
      eq(col: string, val: string) {
        filters[col] = val;
        // Terminal for update/delete once all filters are applied; Supabase
        // resolves on await, so return a thenable that also stays chainable.
        return chain;
      },
      lt() { return chain; },
      async maybeSingle() {
        if (name === "tracker_exit_daily_stats") {
          const row = exits.get(key(filters.project_id, filters.day, filters.page_path));
          return { data: row ? { count: row.count } : null, error: null };
        }
        const s = sessions.get(key(filters.project_id, filters.session_id));
        return { data: s ? { last_page_path: s.last_page_path, last_day: s.last_day } : null, error: null };
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(exec()).then(resolve);
      },
    };

    function exec() {
      if (op === "insert" && pending) {
        if (name === "tracker_exit_daily_stats") {
          exits.set(key(pending.project_id as string, pending.day as string, pending.page_path as string), {
            project: pending.project_id as string, day: pending.day as string, page: pending.page_path as string, count: pending.count as number,
          });
        } else {
          sessions.set(key(pending.project_id as string, pending.session_id as string), {
            project: pending.project_id as string, session: pending.session_id as string,
            last_page_path: pending.last_page_path as string, last_day: pending.last_day as string,
          });
        }
      } else if (op === "update" && pending) {
        if (name === "tracker_exit_daily_stats") {
          const k = key(filters.project_id, filters.day, filters.page_path);
          const row = exits.get(k);
          if (row) row.count = pending.count as number;
        } else {
          const k = key(filters.project_id, filters.session_id);
          const s = sessions.get(k);
          if (s) { s.last_page_path = pending.last_page_path as string; s.last_day = pending.last_day as string; }
        }
      }
      return { data: null, error: null };
    }

    return chain;
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sb: { from: (name: string) => table(name) } as any,
    exitCount: (project: string, day: string, page: string) =>
      exits.get(key(project, day, page))?.count ?? 0,
  };
}

const P = "proj-1";
const DAY = "2026-07-04";

describe("updateExitRollup", () => {
  it("counts the first pageview of a session as its exit page", async () => {
    const { sb, exitCount } = makeFakeSb();
    await updateExitRollup(sb, P, "s1", "/pricing", DAY);
    expect(exitCount(P, DAY, "/pricing")).toBe(1);
  });

  it("moves the exit marker to the session's latest page", async () => {
    const { sb, exitCount } = makeFakeSb();
    await updateExitRollup(sb, P, "s1", "/pricing", DAY);
    await updateExitRollup(sb, P, "s1", "/checkout", DAY);
    expect(exitCount(P, DAY, "/pricing")).toBe(0); // no longer the exit
    expect(exitCount(P, DAY, "/checkout")).toBe(1);
  });

  it("does not change counts when the same page repeats within a session", async () => {
    const { sb, exitCount } = makeFakeSb();
    await updateExitRollup(sb, P, "s1", "/pricing", DAY);
    await updateExitRollup(sb, P, "s1", "/pricing", DAY); // reload
    expect(exitCount(P, DAY, "/pricing")).toBe(1);
  });

  it("counts distinct sessions independently", async () => {
    const { sb, exitCount } = makeFakeSb();
    await updateExitRollup(sb, P, "s1", "/pricing", DAY);
    await updateExitRollup(sb, P, "s2", "/pricing", DAY);
    await updateExitRollup(sb, P, "s2", "/checkout", DAY);
    expect(exitCount(P, DAY, "/pricing")).toBe(1); // s1 still exits here
    expect(exitCount(P, DAY, "/checkout")).toBe(1); // s2 moved here
  });

  it("never lets a decrement drive a count below zero", async () => {
    const { sb, exitCount } = makeFakeSb();
    // Two sessions land on /a, then both move to /b.
    await updateExitRollup(sb, P, "s1", "/a", DAY);
    await updateExitRollup(sb, P, "s2", "/a", DAY);
    await updateExitRollup(sb, P, "s1", "/b", DAY);
    await updateExitRollup(sb, P, "s2", "/b", DAY);
    expect(exitCount(P, DAY, "/a")).toBe(0);
    expect(exitCount(P, DAY, "/b")).toBe(2);
  });
});
