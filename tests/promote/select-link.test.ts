import { describe, it, expect, beforeEach } from "vitest";
import { selectNextLink } from "@/lib/promote/selectLink";
import { makeFakeSupabase, resetIds, type FakeDb } from "./fake-supabase";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function link(over: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    list_id: "list-a",
    url: "https://example.com/a",
    title: "A",
    angle: null,
    summary: null,
    source_name: null,
    source_id: null,
    ownership: "owned",
    enabled: true,
    last_promoted_at: null,
    times_promoted: 0,
    ...over,
  };
}

function db(over: Partial<FakeDb> = {}): FakeDb {
  return { promo_link: [], promo_post: [], ...over };
}

const list = {
  id: "list-a",
  source_mix: { owned: 70, partner: 0, shared: 30 },
  fallback_policy: {
    whenOwnedQueueEmpty: "use_shared",
    whenSharedQueueEmpty: "use_owned",
    maxFallbackItemsPerDay: 3,
  },
};

beforeEach(() => resetIds());

describe("selectNextLink", () => {
  it("returns nothing for an empty list", async () => {
    const { client } = makeFakeSupabase(db());
    const selection = await selectNextLink(client, list, NOW);
    expect(selection.link).toBeNull();
    expect(selection.decision.reason).toBe("no_inventory");
  });

  it("prefers the owned link on a fresh 70/30 list", async () => {
    const { client } = makeFakeSupabase(
      db({
        promo_link: [
          link({ id: "owned-1", ownership: "owned" }),
          link({ id: "shared-1", ownership: "shared" }),
        ],
      }),
    );
    const selection = await selectNextLink(client, list, NOW);
    expect(selection.link?.id).toBe("owned-1");
    expect(selection.decision.viaFallback).toBe(false);
  });

  it("switches to shared once owned is ahead of target", async () => {
    const { client } = makeFakeSupabase(
      db({
        promo_link: [
          link({ id: "owned-1", ownership: "owned" }),
          link({ id: "shared-1", ownership: "shared" }),
        ],
        promo_post: Array.from({ length: 8 }, (_, i) => ({
          id: `post-${i}`,
          list_id: "list-a",
          ownership: "owned",
          status: "posted",
          via_fallback: false,
          created_at: `2026-08-18T0${i}:00:00.000Z`,
        })),
      }),
    );
    const selection = await selectNextLink(client, list, NOW);
    expect(selection.link?.id).toBe("shared-1");
  });

  it("rotates within a class: least recently promoted first", async () => {
    const { client } = makeFakeSupabase(
      db({
        promo_link: [
          link({ id: "old", ownership: "owned", last_promoted_at: "2026-08-18T09:00:00.000Z" }),
          link({ id: "older", ownership: "owned", last_promoted_at: "2026-08-18T08:00:00.000Z" }),
          link({ id: "never", ownership: "owned", last_promoted_at: null }),
        ],
      }),
    );
    // A link that has never posted goes first.
    expect((await selectNextLink(client, list, NOW)).link?.id).toBe("never");
  });

  it("ignores disabled links", async () => {
    const { client } = makeFakeSupabase(
      db({
        promo_link: [
          link({ id: "off", ownership: "owned", enabled: false }),
          link({ id: "on", ownership: "shared" }),
        ],
      }),
    );
    const selection = await selectNextLink(client, list, NOW);
    expect(selection.link?.id).toBe("on");
    expect(selection.decision.viaFallback).toBe(true);
  });

  it("falls back to shared when the owned queue is empty", async () => {
    const { client } = makeFakeSupabase(
      db({ promo_link: [link({ id: "shared-1", ownership: "shared" })] }),
    );
    const selection = await selectNextLink(client, list, NOW);
    expect(selection.link?.id).toBe("shared-1");
    expect(selection.decision.viaFallback).toBe(true);
    expect(selection.decision.reason).toBe("fallback");
  });

  it("stops falling back once the daily cap is spent", async () => {
    const { client } = makeFakeSupabase(
      db({
        promo_link: [link({ id: "shared-1", ownership: "shared" })],
        promo_post: Array.from({ length: 3 }, (_, i) => ({
          id: `fb-${i}`,
          list_id: "list-a",
          ownership: "shared",
          status: "posted",
          via_fallback: true,
          created_at: "2026-08-18T10:00:00.000Z",
        })),
      }),
    );
    const selection = await selectNextLink(client, list, NOW);
    expect(selection.link).toBeNull();
    expect(selection.decision.reason).toBe("fallback_cap_reached");
  });

  it("counts fallbacks in a rolling window, not forever", async () => {
    const { client } = makeFakeSupabase(
      db({
        promo_link: [link({ id: "shared-1", ownership: "shared" })],
        promo_post: Array.from({ length: 3 }, (_, i) => ({
          id: `fb-${i}`,
          list_id: "list-a",
          ownership: "shared",
          status: "posted",
          via_fallback: true,
          // Two days ago: outside the window, so it must not still block.
          created_at: "2026-08-16T10:00:00.000Z",
        })),
      }),
    );
    const selection = await selectNextLink(client, list, NOW);
    expect(selection.link?.id).toBe("shared-1");
  });

  it("treats pre-source posts with no ownership as owned", async () => {
    // Lists that predate content sources have promo_post rows with a null
    // ownership. They were all hand-pasted links, so they must count as owned
    // or the blend reads the history as 100% shared and never posts shared.
    const { client } = makeFakeSupabase(
      db({
        promo_link: [
          link({ id: "owned-1", ownership: "owned" }),
          link({ id: "shared-1", ownership: "shared" }),
        ],
        promo_post: Array.from({ length: 9 }, (_, i) => ({
          id: `legacy-${i}`,
          list_id: "list-a",
          ownership: null,
          status: "posted",
          via_fallback: false,
          created_at: `2026-08-18T0${i}:00:00.000Z`,
        })),
      }),
    );
    const selection = await selectNextLink(client, list, NOW);
    expect(selection.link?.id).toBe("shared-1");
  });

  it("counts pending posts, so cookie-auth platforms do not skew the ratio", async () => {
    const { client } = makeFakeSupabase(
      db({
        promo_link: [
          link({ id: "owned-1", ownership: "owned" }),
          link({ id: "shared-1", ownership: "shared" }),
        ],
        promo_post: Array.from({ length: 8 }, (_, i) => ({
          id: `p-${i}`,
          list_id: "list-a",
          ownership: "owned",
          status: "pending",
          via_fallback: false,
          created_at: `2026-08-18T0${i}:00:00.000Z`,
        })),
      }),
    );
    expect((await selectNextLink(client, list, NOW)).link?.id).toBe("shared-1");
  });

  it("ignores another list's history", async () => {
    const { client } = makeFakeSupabase(
      db({
        promo_link: [
          link({ id: "owned-1", ownership: "owned" }),
          link({ id: "shared-1", ownership: "shared" }),
        ],
        promo_post: Array.from({ length: 20 }, (_, i) => ({
          id: `other-${i}`,
          list_id: "list-other",
          ownership: "owned",
          status: "posted",
          via_fallback: false,
          created_at: "2026-08-18T10:00:00.000Z",
        })),
      }),
    );
    expect((await selectNextLink(client, list, NOW)).link?.id).toBe("owned-1");
  });
});
