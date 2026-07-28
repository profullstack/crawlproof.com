import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The leads page casts its campaign rows with `as CampaignSummary`, which
// tells TypeScript what the shape is without checking that the query asked
// for it. A column missing from the select then reads as `undefined` at
// runtime with no compile error — which is exactly how the run history and
// the waiting_for_auth badge shipped broken.
//
// This asserts the select actually requests every field the page and panel
// go on to read. It is a source-level check, which is unusual, but it is the
// only thing that catches a mismatch the type system is being told to ignore.

const PAGE = path.join(process.cwd(), "app/(app)/projects/[id]/leads/page.tsx");

/** Fields the page maps or the panel renders. */
const REQUIRED_COLUMNS = [
  "id",
  "name",
  "active",
  "auto_send",
  "daily_send_limit",
  "max_score",
  "queries",
  "seed_urls",
  "last_run_at",
  "last_run_note",
  "auth_required_hosts",
  "pitch_mode",
  "pitch_intro",
  "pitch_ask",
  "pitch_facts",
  "scan_prospects",
  "angle",
  "sender_name",
  "reply_to",
];

function campaignSelect(source: string): string {
  const idx = source.indexOf('.from("outreach_campaigns")');
  expect(idx, "leads page no longer queries outreach_campaigns").toBeGreaterThan(-1);
  const after = source.slice(idx);
  const match = after.match(/\.select\(\s*"([^"]+)"/);
  expect(match, "could not find the campaign .select(...)").not.toBeNull();
  return match![1];
}

describe("leads page campaign query", () => {
  const source = readFileSync(PAGE, "utf8");
  const selected = campaignSelect(source)
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  for (const column of REQUIRED_COLUMNS) {
    it(`selects ${column}`, () => {
      expect(selected).toContain(column);
    });
  }

  it("selects id, without which run history cannot be keyed", () => {
    // Called out separately because its absence fails silently: the map
    // lookup just misses and every campaign shows an empty history.
    expect(selected).toContain("id");
  });
});
