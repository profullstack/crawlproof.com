import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AD_FORMAT_IDS } from "@/lib/ads/formats";
import { rotatesMedia } from "@/lib/ads/media";

// ad_media_bucket (20260928120000) names the formats that rotate by hand, in
// SQL, because the rollup cannot call TypeScript. If a format gains a second
// presentation in MEDIA_BY_FORMAT and the SQL is not updated, every fill of it
// is booked as 'fixed' and the rotation it now runs is invisible — or, the
// other way round, a one-presentation format lands in the static arm and makes
// it read ~99% again. Pin the two lists together.

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260928120000_ad_media_split_fixed_formats.sql",
);

describe("ad_media_bucket's rotating formats", () => {
  it("are exactly the formats rotatesMedia() says rotate", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const m = sql.match(/p_format in \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const inSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    const rotating = AD_FORMAT_IDS.filter(rotatesMedia).sort();
    expect(inSql).toEqual(rotating);
  });
});
