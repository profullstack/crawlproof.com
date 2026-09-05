import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The kind-split migration is applied by hand, so this is the only place its
// shape is checked before it reaches prod. It pins the things that were easy
// to get wrong: every panel RPC has to accept p_kind or the page 404s on the
// missing signature; the three portfolio functions that spill their
// HashAggregate must keep their work_mem or /dashboard/analytics times out
// again; and no tracker RPC may ever become security definer, because they
// take project ids from the caller and lean on RLS.

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260905190000_tracker_kind_split.sql",
  ),
  "utf8",
);

const KIND_TABLES = [
  "tracker_event_daily_stats",
  "tracker_device_daily_stats",
  "tracker_geo_daily_stats",
  "tracker_exit_daily_stats",
];

const SINGLE_RPCS: Array<[string, string]> = [
  ["tracker_daily_series", "uuid, integer"],
  ["tracker_bucket_totals", "uuid, integer, integer"],
  ["tracker_event_mix", "uuid, integer"],
  ["tracker_top_pages", "uuid, integer, integer"],
  ["tracker_top_referrers", "uuid, integer, integer"],
  ["tracker_top_actions", "uuid, integer, integer"],
  ["tracker_top_exit_pages", "uuid, integer, integer"],
  ["tracker_top_countries", "uuid, integer, integer"],
  ["tracker_top_cities", "uuid, integer, integer"],
  ["tracker_device_totals", "uuid, integer"],
];

const MULTI_RPCS: Array<[string, string]> = [
  ["tracker_daily_series_multi", "uuid[], integer"],
  ["tracker_bucket_totals_multi", "uuid[], integer, integer"],
  ["tracker_event_mix_multi", "uuid[], integer"],
  ["tracker_top_pages_multi", "uuid[], integer, integer"],
  ["tracker_top_exit_pages_multi", "uuid[], integer, integer"],
  ["tracker_top_referrers_multi", "uuid[], integer, integer"],
  ["tracker_top_actions_multi", "uuid[], integer, integer"],
  ["tracker_top_countries_multi", "uuid[], integer, integer"],
  ["tracker_top_cities_multi", "uuid[], integer, integer"],
  ["tracker_device_totals_multi", "uuid[], integer"],
];

const RECENT_RPCS: Array<[string, string]> = [
  ["tracker_recent_series", "uuid, integer, integer"],
  ["tracker_recent_bucket_totals", "uuid, integer, integer"],
  ["tracker_recent_event_mix", "uuid, integer"],
  ["tracker_recent_top_pages", "uuid, integer, integer"],
  ["tracker_recent_top_referrers", "uuid, integer, integer"],
  ["tracker_recent_top_actions", "uuid, integer, integer"],
  ["tracker_recent_top_countries", "uuid, integer, integer"],
  ["tracker_recent_top_cities", "uuid, integer, integer"],
];

const ALL_RPCS = [...SINGLE_RPCS, ...MULTI_RPCS, ...RECENT_RPCS];

const WORK_MEM_RPCS = [
  "tracker_top_pages_multi",
  "tracker_top_actions_multi",
  "tracker_top_exit_pages_multi",
];

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The body of `create function public.<name>(` up to its closing `$$;`. */
function definition(name: string): string {
  const m = migration.match(
    new RegExp(`create function public\\.${esc(name)}\\(([\\s\\S]*?)\\$\\$;`),
  );
  if (!m) throw new Error(`no create function for ${name}`);
  return m[0];
}

describe("tracker kind split migration", () => {
  it("adds kind to each bucket-less rollup and the exit session record, unknown by default", () => {
    for (const table of [...KIND_TABLES, "tracker_exit_sessions"]) {
      expect(migration).toMatch(
        new RegExp(
          `alter table public\\.${table}\\s+add column if not exists kind text not null default 'unknown'`,
        ),
      );
    }
    expect(migration).toContain("check (kind in (''human'', ''bot'', ''unknown''))");
  });

  it("puts kind last in each rollup's primary key, matching the ingest's key columns", () => {
    expect(migration).toContain(
      "'project_id, day, event, page_path, referrer_host, event_target, kind'",
    );
    expect(migration).toContain("'project_id, day, device_type, browser, os, kind'");
    expect(migration).toContain(
      "'project_id, day, country_code, region_code, city, timezone, kind'",
    );
    expect(migration).toContain("'project_id, day, page_path, kind'");
    // Guarded on the current key, so a replay does not rebuild.
    expect(migration).toMatch(/c\.contype = 'p'\s+and a\.attname = 'kind'/);
  });

  it("keeps page_path in the covering indexes and adds kind to the include", () => {
    expect(migration).toMatch(
      /on public\.tracker_event_daily_stats \(project_id, event, day desc\)\s+include \(page_path, count, kind\)/,
    );
    expect(migration).toMatch(
      /on public\.tracker_event_daily_stats \(project_id, day desc\)\s+include \(event, page_path, referrer_host, event_target, count, kind\)/,
    );
    // New names first, then the old ones go, so coverage never lapses.
    const created = migration.indexOf("tracker_event_daily_stats_project_event_day_kind_idx");
    const dropped = migration.indexOf(
      "drop index if exists public.tracker_event_daily_stats_project_event_day_idx",
    );
    expect(created).toBeGreaterThan(-1);
    expect(dropped).toBeGreaterThan(created);
  });

  it("drops each RPC by its exact old signature and re-creates it with p_kind last", () => {
    for (const [name, oldArgs] of ALL_RPCS) {
      expect(migration, name).toContain(
        `drop function if exists public.${name}(${oldArgs});`,
      );
      const def = definition(name);
      expect(def, name).toMatch(/p_kind text default null\n\)/);
      expect(migration, name).toContain(
        `grant execute on function public.${name}(${oldArgs}, text) to authenticated, service_role;`,
      );
    }
  });

  it("filters every RPC by p_kind, on kind for rollups and on the bucket prefix elsewhere", () => {
    for (const [name] of ALL_RPCS) {
      const def = definition(name);
      const onKind = def.includes("(p_kind is null or kind = p_kind)");
      const onBucket =
        def.includes("(p_kind = 'bot' and bucket like 'bot:%')") ||
        def.includes("(p_kind = 'bot' and e.bucket like 'bot:%')");
      expect(onKind || onBucket, name).toBe(true);
    }
    // The bucket table and the raw table have no kind column.
    for (const name of [
      "tracker_bucket_totals",
      "tracker_bucket_totals_multi",
      ...RECENT_RPCS.map(([n]) => n),
    ]) {
      expect(definition(name), name).not.toContain("kind = p_kind");
    }
    // The series RPCs filter both legs.
    for (const name of ["tracker_daily_series", "tracker_daily_series_multi"]) {
      const def = definition(name);
      expect(def, name).toContain("(p_kind is null or kind = p_kind)");
      expect(def, name).toContain("(p_kind = 'human' and bucket not like 'bot:%')");
    }
  });

  it("keeps work_mem on the three portfolio functions that spill, and only those", () => {
    for (const [name] of ALL_RPCS) {
      const hasWorkMem = /set work_mem = '16MB'/.test(definition(name));
      expect(hasWorkMem, name).toBe(WORK_MEM_RPCS.includes(name));
    }
  });

  it("never makes a tracker RPC security definer", () => {
    expect(migration).not.toMatch(/security definer/i);
    for (const [name] of ALL_RPCS) {
      expect(definition(name), name).toContain("security invoker");
      expect(definition(name), name).toContain("set search_path = public");
    }
  });

  it("says that rows before it are unknown and only appear under All", () => {
    expect(migration).toMatch(/ROWS BEFORE THIS MIGRATION ARE `unknown`/);
    expect(migration).toMatch(/appear only under All/);
  });
});
