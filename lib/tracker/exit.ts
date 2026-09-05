// Exit-page rollups for the drop-in stats tracker.
//
// The "exit page" of a session is its most recent pageview — the last page a
// visitor was on before leaving. We can't know at ingest time whether a given
// pageview is the last one, so we keep a small per-session "current last page"
// record (tracker_exit_sessions) and *move* the +1 exit marker forward as the
// session advances: decrement the page the session was previously counted on,
// increment the new one. tracker_exit_daily_stats therefore always reflects,
// for each session, exactly one exit page — its latest pageview so far.
//
// Each exit row is keyed by `kind` (human / bot, lib/tracker/humans.ts) as
// well as day and path, so the stats page can show human exits apart from
// crawler exits. The session record remembers the kind it was counted under,
// and the decrement uses that, never the current hit's: a session that began
// before the kind-split migration sits on an `unknown` row and must be taken
// off that row, not off a `human` row that was never incremented.
//
// Lives here (rather than inline in /api/track) so it's unit-testable without
// dragging in the full ingest route, mirroring lib/tracker/device.ts & geo.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrackerKind } from "@/lib/tracker/humans";

// The service client is typed permissively (DB = any) in this repo, so accept
// any Supabase client here too.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = SupabaseClient<any>;

/** What the rollup row records; `unknown` only on rows from before the split. */
export type ExitKind = TrackerKind | "unknown";

// Bump a single exit-page counter by `delta` using the same read-modify-write
// upsert pattern as the other tracker rollups. Counts are clamped at 0 so a
// decrement racing ahead of its matching increment can never go negative.
export async function bumpExit(
  sb: Sb,
  project: string,
  day: string,
  pagePath: string,
  delta: number,
  kind: ExitKind,
) {
  const { data: existing } = await sb
    .from("tracker_exit_daily_stats")
    .select("count")
    .eq("project_id", project)
    .eq("day", day)
    .eq("page_path", pagePath)
    .eq("kind", kind)
    .maybeSingle();

  if (existing) {
    await sb
      .from("tracker_exit_daily_stats")
      .update({
        count: Math.max(0, (existing.count ?? 0) + delta),
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", project)
      .eq("day", day)
      .eq("page_path", pagePath)
      .eq("kind", kind);
  } else if (delta > 0) {
    await sb
      .from("tracker_exit_daily_stats")
      .insert({ project_id: project, day, page_path: pagePath, kind, count: delta });
  }
}

// Move this session's exit marker to the current pageview. Call only for
// pageview events that carry a session id.
export async function updateExitRollup(
  sb: Sb,
  project: string,
  sessionId: string,
  pagePath: string,
  today: string,
  kind: TrackerKind,
) {
  const { data: session } = await sb
    .from("tracker_exit_sessions")
    .select("last_page_path, last_day, kind")
    .eq("project_id", project)
    .eq("session_id", sessionId)
    .maybeSingle();

  if (session) {
    // The row this session is currently counted on. Sessions written before
    // the split carry no kind and sit on an `unknown` row.
    const previousKind: ExitKind = session.kind ?? "unknown";
    // Already counted on the same page, day and kind — nothing to move.
    if (
      session.last_page_path === pagePath &&
      session.last_day === today &&
      previousKind === kind
    ) {
      return;
    }
    await bumpExit(sb, project, session.last_day, session.last_page_path, -1, previousKind);
    await bumpExit(sb, project, today, pagePath, 1, kind);
    await sb
      .from("tracker_exit_sessions")
      .update({
        last_page_path: pagePath,
        last_day: today,
        kind,
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", project)
      .eq("session_id", sessionId);
  } else {
    await bumpExit(sb, project, today, pagePath, 1, kind);
    await sb
      .from("tracker_exit_sessions")
      .insert({
        project_id: project,
        session_id: sessionId,
        last_page_path: pagePath,
        last_day: today,
        kind,
      });
  }
}

// Prune session bookkeeping well past the client-side 30-min session TTL so a
// stale session id can never be resurrected and double-counted.
export async function pruneExitSessions(sb: Sb, project: string) {
  await sb
    .from("tracker_exit_sessions")
    .delete()
    .eq("project_id", project)
    .lt(
      "updated_at",
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    );
}
