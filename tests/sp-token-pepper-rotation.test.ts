import { afterEach, describe, expect, it } from "vitest";
import { env } from "@/lib/env";
import { apiTokenLookupHashes, hashApiToken } from "@/lib/sp/apiToken";
import { affiliateTokenLookupHashes, hashAffiliateToken } from "@/lib/affiliate/tokens";
import { actorTokenLookupHashes, hashActorToken } from "@/lib/tracker/actors";
import { previousPepper } from "@/lib/sp/pepper";

const saved = { cur: env.spTokenPepper, prev: env.spTokenPepperPrevious };
afterEach(() => {
  env.spTokenPepper = saved.cur;
  env.spTokenPepperPrevious = saved.prev;
});

const TOKEN = "crp_" + "a".repeat(43);

describe("SP_TOKEN_PEPPER rotation", () => {
  it("looks up by the current hash only when no rotation is in progress", () => {
    env.spTokenPepper = "new";
    env.spTokenPepperPrevious = "";
    expect(apiTokenLookupHashes(TOKEN)).toEqual({ current: hashApiToken(TOKEN), all: [hashApiToken(TOKEN)] });
    expect(previousPepper()).toBeNull();
  });

  it("still finds a token hashed under the previous pepper, current hash first", () => {
    env.spTokenPepper = "old";
    const oldApi = hashApiToken(TOKEN);
    const oldAff = hashAffiliateToken(TOKEN);
    const oldActor = hashActorToken(TOKEN);

    env.spTokenPepper = "new";
    env.spTokenPepperPrevious = "old";
    for (const [lookup, hash, old] of [
      [apiTokenLookupHashes, hashApiToken, oldApi],
      [affiliateTokenLookupHashes, hashAffiliateToken, oldAff],
      [actorTokenLookupHashes, hashActorToken, oldActor],
    ] as const) {
      const h = lookup(TOKEN);
      expect(h.current).toBe(hash(TOKEN));
      expect(h.current).not.toBe(old);
      expect(h.all).toEqual([h.current, old]);
    }
  });

  it("keeps the actor domain separate from API tokens under both peppers", () => {
    env.spTokenPepper = "new";
    env.spTokenPepperPrevious = "old";
    const api = apiTokenLookupHashes(TOKEN).all;
    for (const h of actorTokenLookupHashes(TOKEN).all) expect(api).not.toContain(h);
  });

  it("ignores a previous pepper equal to the current one", () => {
    env.spTokenPepper = "same";
    env.spTokenPepperPrevious = "same";
    expect(apiTokenLookupHashes(TOKEN).all).toHaveLength(1);
  });

  it("refuses to hash without a current pepper", () => {
    env.spTokenPepper = "";
    env.spTokenPepperPrevious = "old";
    expect(() => apiTokenLookupHashes(TOKEN)).toThrow("SP_TOKEN_PEPPER not set.");
  });
});
