/**
 * A loader's result together with whether the query behind it actually ran.
 *
 * Every loader that uses this zero-fills rather than throwing, so one failing
 * panel cannot take the whole page down with it. That part is deliberate and
 * stays. What it cost is a way to tell the two apart: a cancelled query and a
 * genuinely quiet range produced byte-identical output, so a dashboard could
 * report zeros over a live pipeline and say nothing was wrong.
 *
 * That has now happened on both halves of the product. On the ad surfaces it
 * took four goes to pin down — the paid-only measure (#199), the same bug on
 * two more surfaces (#225), and RPCs cancelled by statement_timeout (#226).
 * The tracker surfaces swallowed their errors the same way and reported 0
 * pageviews for every project while ingest was writing rows every second.
 *
 * `failed` is how a caller tells "we could not load this" from "this is 0".
 */
export type Loaded<T> = { data: T; failed: boolean };

/**
 * Record an RPC failure and report whether there was one.
 *
 * Logs, because the error was previously discarded at the point of failure:
 * the only surviving evidence that a query had been cancelled was in Postgres'
 * own logs, which is a long way to go to explain a tile reading 0.
 */
export function rpcFailed(
  scope: string,
  name: string,
  error: { message?: string } | null,
): boolean {
  if (!error) return false;
  console.error(
    `[${scope}] RPC ${name} failed: ${error.message ?? "unknown error"}`,
  );
  return true;
}
