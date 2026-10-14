import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  GUEST_POST_EVERY,
  isGuestPostSlot,
  planGuestPost,
} from "@/lib/lx/autoGuestPost";

vi.mock("@/lib/lx/guestPostMatcher", () => ({
  findGuestPostOpportunities: vi.fn(),
}));

import { findGuestPostOpportunities } from "@/lib/lx/guestPostMatcher";

const matcher = vi.mocked(findGuestPostOpportunities);

/**
 * A Supabase stub that answers each table with whatever the test hands it.
 *
 * The chain shapes here mirror the real calls exactly — `.select(...,{count,head})`
 * for the cadence count and `.select().eq().gte()` for the cooldown — because
 * getting one of those wrong is precisely the kind of mistake that returns
 * `undefined` and silently disables the feature rather than failing.
 */
function stubSupabase(
  opts: {
    articleCount?: number;
    countError?: string;
    recentGuestTargets?: string[];
    existingRequests?: Array<{ target_site_id: string; topic: string }>;
  },
  filters: string[] = [],
) {
  return {
    from(table: string) {
      if (table === "lx_article") {
        return {
          select(_cols: string, o?: { count?: string; head?: boolean }) {
            if (o?.head) {
              return {
                or: (f: string) => {
                  filters.push(`or:${f}`);
                  return Promise.resolve(
                    opts.countError
                      ? { count: null, error: { message: opts.countError } }
                      : { count: opts.articleCount ?? 0, error: null },
                  );
                },
              };
            }
            return {
              eq: (col: string, val: unknown) => ({
                eq: (col2: string, val2: unknown) => ({
                  gte: () => {
                    filters.push(`eq:${col}=${String(val)}`, `eq:${col2}=${String(val2)}`);
                    return Promise.resolve({
                      data: (opts.recentGuestTargets ?? []).map((id) => ({
                        target_site_id: id,
                      })),
                    });
                  },
                }),
              }),
            };
          },
        };
      }
      if (table === "lx_guest_post_request") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: opts.existingRequests ?? [] }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as never;
}

const opportunity = (id: string, topics: string[], score = 1) => ({
  partner_site_id: id,
  partner_domain: `${id}.example`,
  partner_niche: null,
  partner_blog_root_url: null,
  score,
  suggested_topics: topics,
});

beforeEach(() => {
  matcher.mockReset();
});

describe("guest post cadence", () => {
  it("fires on every tenth post and no others", async () => {
    // Counted from articles already on file, so the cadence follows reality
    // rather than a counter somebody has to remember to increment.
    const fired: number[] = [];
    for (let published = 0; published < 30; published += 1) {
      if (await isGuestPostSlot(stubSupabase({ articleCount: published }), "author")) {
        fired.push(published + 1);
      }
    }
    expect(fired).toEqual([10, 20, 30]);
    expect(GUEST_POST_EVERY).toBe(10);
  });

  it("does not turn every slot into a guest post when the count fails", async () => {
    // The safe direction. Failing "no" keeps the customer's own blog
    // publishing, which is the obligation that matters; failing "yes" would
    // redirect every post on the schedule to somebody else's domain.
    const slot = await isGuestPostSlot(
      stubSupabase({ countError: "connection reset" }),
      "author",
    );
    expect(slot).toBe(false);
  });

  it("counts the guest posts this site wrote, which live under the partner", async () => {
    // Counting by site_id alone never saw them, so a site one short of a
    // multiple of ten was handed a guest slot on every tick, for ever.
    const filters: string[] = [];
    await isGuestPostSlot(stubSupabase({}, filters), "author");
    expect(filters).toEqual([
      "or:and(site_id.eq.author,is_guest_post.eq.false),author_site_id.eq.author",
    ]);
  });
});

describe("choosing a partner", () => {
  it("takes the highest-ranked partner and its first crossed topic", async () => {
    matcher.mockResolvedValue([
      opportunity("best", ["ai for logistics", "fleet telemetry"], 9),
      opportunity("second", ["something else"], 3),
    ]);

    const plan = await planGuestPost(stubSupabase({}), "author");

    expect(plan).toEqual({
      targetSiteId: "best",
      targetDomain: "best.example",
      topic: "ai for logistics",
    });
  });

  it("skips a partner written for inside the cooldown", async () => {
    // Ranking is stable and the matcher has no memory, so without this the
    // top partner would receive a post every ten slots for ever -- which is
    // the shape that gets a link network discounted.
    matcher.mockResolvedValue([
      opportunity("recent", ["topic a"], 9),
      opportunity("fresh", ["topic b"], 4),
    ]);

    const plan = await planGuestPost(
      stubSupabase({ recentGuestTargets: ["recent"] }),
      "author",
    );

    expect(plan?.targetSiteId).toBe("fresh");
  });

  it("looks up the cooldown by author, not by the site the post lives on", async () => {
    // The same mistake as the cadence count: by site_id the cooldown found
    // nothing, and one partner got the same post seventeen days running.
    matcher.mockResolvedValue([opportunity("partner", ["topic a"])]);
    const filters: string[] = [];
    await planGuestPost(stubSupabase({}, filters), "author");
    expect(filters).toEqual(["eq:author_site_id=author", "eq:is_guest_post=true"]);
  });

  it("does not commission a topic a human already requested", async () => {
    // The manual path and the cron share one ledger so they cannot
    // independently order the same article.
    matcher.mockResolvedValue([opportunity("partner", ["Taken Topic", "free topic"])]);

    const plan = await planGuestPost(
      stubSupabase({
        existingRequests: [{ target_site_id: "partner", topic: "taken topic" }],
      }),
      "author",
    );

    expect(plan?.topic).toBe("free topic");
  });

  it("returns null rather than a bad target when nothing is available", async () => {
    // The caller publishes an ordinary post instead. A slot is never spent on
    // a guest post that cannot be placed -- the schedule is what the customer
    // is paying for.
    matcher.mockResolvedValue([opportunity("only", ["one topic"])]);

    const plan = await planGuestPost(
      stubSupabase({
        recentGuestTargets: ["only"],
      }),
      "author",
    );

    expect(plan).toBeNull();
  });

  it("returns null when the network is empty", async () => {
    matcher.mockResolvedValue([]);
    expect(await planGuestPost(stubSupabase({}), "author")).toBeNull();
  });

  it("survives the matcher throwing", async () => {
    // Discovery reaching out across the network is the part most likely to
    // fail, and it must not take the publishing schedule with it.
    matcher.mockRejectedValue(new Error("partner query exploded"));
    expect(await planGuestPost(stubSupabase({}), "author")).toBeNull();
  });
});
