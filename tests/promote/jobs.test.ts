import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  claimJob,
  idempotencyKeyFor,
  planJobs,
  reapStalePublishingJobs,
  settleJob,
  PUBLISH_LEASE_MS,
  type PlanJobInput,
} from "@/lib/promote/jobs";
import { makeFakeSupabase, resetIds, type FakeDb, type UniqueConstraint } from "./fake-supabase";

// The unique index that carries the whole guarantee.
const CONSTRAINTS: UniqueConstraint[] = [
  { table: "promo_job", columns: ["idempotency_key"] },
];

const SLOT = "2026-08-19T12:00:00.000Z";

function plan(over: Partial<PlanJobInput> = {}): PlanJobInput {
  return {
    userId: "user-1",
    listId: "list-a",
    linkId: "link-1",
    accountId: "acct-1",
    platform: "bluesky",
    resolvedUrl: "https://example.com/a",
    resolvedTitle: "A",
    ownership: "owned",
    sourceId: null,
    viaFallback: false,
    slotAt: SLOT,
    ...over,
  };
}

function db(over: Partial<FakeDb> = {}): FakeDb {
  return { promo_job: [], ...over };
}

beforeEach(() => {
  resetIds();
});

describe("idempotencyKeyFor", () => {
  it("is stable for the same intended publication", () => {
    const a = idempotencyKeyFor({ listId: "l", linkId: "k", accountId: "a", slotAt: SLOT });
    const b = idempotencyKeyFor({ listId: "l", linkId: "k", accountId: "a", slotAt: SLOT });
    expect(a).toBe(b);
  });

  it("separates every axis of the intent", () => {
    const base = { listId: "l", linkId: "k", accountId: "a", slotAt: SLOT };
    const key = idempotencyKeyFor(base);

    expect(idempotencyKeyFor({ ...base, listId: "l2" })).not.toBe(key);
    expect(idempotencyKeyFor({ ...base, linkId: "k2" })).not.toBe(key);
    expect(idempotencyKeyFor({ ...base, accountId: "a2" })).not.toBe(key);
    expect(idempotencyKeyFor({ ...base, slotAt: "2026-08-19T13:00:00.000Z" })).not.toBe(key);
    expect(idempotencyKeyFor({ ...base, destinationKey: "r/bitcoin" })).not.toBe(key);
    expect(idempotencyKeyFor({ ...base, kind: "crosspost" })).not.toBe(key);
  });

  it("reads two spellings of the same instant as one slot", () => {
    // Postgres and JS disagree about how to render a timestamptz. If the key
    // took the raw string, the same due time read back differently would look
    // like a different slot and the second sweep would publish again.
    const base = { listId: "l", linkId: "k", accountId: "a" };
    expect(idempotencyKeyFor({ ...base, slotAt: "2026-08-19T12:00:00.000Z" })).toBe(
      idempotencyKeyFor({ ...base, slotAt: "2026-08-19T12:00:00+00:00" }),
    );
  });

  it("treats a missing destination as the empty destination, not as absent", () => {
    const base = { listId: "l", linkId: "k", accountId: "a", slotAt: SLOT };
    expect(idempotencyKeyFor(base)).toBe(idempotencyKeyFor({ ...base, destinationKey: "" }));
    expect(idempotencyKeyFor(base)).toBe(idempotencyKeyFor({ ...base, destinationKey: null }));
  });
});

describe("planJobs", () => {
  it("writes one queued job per intended publication", async () => {
    const { client, db: store } = makeFakeSupabase(db(), CONSTRAINTS);

    const jobs = await planJobs(client, [
      plan({ accountId: "acct-1", platform: "bluesky" }),
      plan({ accountId: "acct-2", platform: "mastodon" }),
    ]);

    expect(jobs).toHaveLength(2);
    expect(store.promo_job).toHaveLength(2);
    expect(jobs.every((j) => j.state === "queued")).toBe(true);
    // The copy is not written until a worker wins the claim and pays for it.
    expect(jobs.every((j) => j.resolved_body === null)).toBe(true);
  });

  it("plans nothing for a slot another sweep already planned", async () => {
    // The race the whole change exists for: the 60s tick and a "Post now"
    // trigger both reach the same due campaign and reach the same decision.
    const { client, db: store } = makeFakeSupabase(db(), CONSTRAINTS);

    const first = await planJobs(client, [plan()]);
    const second = await planJobs(client, [plan()]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(store.promo_job).toHaveLength(1);
  });

  it("plans the same publication again on the next slot", async () => {
    // Deduping must be per tick, not forever — a drip campaign is supposed to
    // post the same link again later.
    const { client, db: store } = makeFakeSupabase(db(), CONSTRAINTS);

    await planJobs(client, [plan({ slotAt: SLOT })]);
    const next = await planJobs(client, [plan({ slotAt: "2026-08-19T12:30:00.000Z" })]);

    expect(next).toHaveLength(1);
    expect(store.promo_job).toHaveLength(2);
  });

  it("returns only the jobs this caller created when a slot is half planned", async () => {
    const { client } = makeFakeSupabase(db(), CONSTRAINTS);

    await planJobs(client, [plan({ accountId: "acct-1" })]);
    const rest = await planJobs(client, [
      plan({ accountId: "acct-1" }),
      plan({ accountId: "acct-2" }),
    ]);

    expect(rest.map((j) => j.account_id)).toEqual(["acct-2"]);
  });

  it("publishes nothing, loudly, when the job table cannot be written", async () => {
    // The migration-not-applied case. Returning [] means the sweep publishes
    // nothing; the console.error is what stops it being a silent stop.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      from: () => ({
        upsert: () => ({
          select: async () => ({
            data: null,
            error: { message: 'relation "promo_job" does not exist' },
          }),
        }),
      }),
    } as any;

    const jobs = await planJobs(client, [plan()]);

    expect(jobs).toEqual([]);
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0])).toContain("publishing nothing this tick");
    spy.mockRestore();
  });

  it("is a no-op for an empty plan", async () => {
    const { client } = makeFakeSupabase(db(), CONSTRAINTS);
    expect(await planJobs(client, [])).toEqual([]);
  });
});

describe("claimJob", () => {
  it("lets exactly one worker take a job", async () => {
    const { client, db: store } = makeFakeSupabase(db(), CONSTRAINTS);
    const [job] = await planJobs(client, [plan()]);

    expect(await claimJob(client, job)).toBe(true);
    // The second worker read 'queued' before the first wrote — its update
    // matches nothing, which is the point of the predicate.
    expect(await claimJob(client, job)).toBe(false);

    const stored = store.promo_job[0];
    expect(stored.state).toBe("publishing");
    expect(stored.attempt_count).toBe(1);
    expect(stored.locked_at).toBeTruthy();
  });

  it("will not take a job that has already been settled", async () => {
    const { client } = makeFakeSupabase(db(), CONSTRAINTS);
    const [job] = await planJobs(client, [plan()]);

    await claimJob(client, job);
    await settleJob(client, job.id, { state: "published", promoPostId: "post-1" });

    expect(await claimJob(client, job)).toBe(false);
  });

  it("does not take a job when the claim errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: async () => ({ data: null, error: { message: "boom" } }),
            }),
          }),
        }),
      }),
    } as any;

    expect(await claimJob(client, { id: "job-1", attempt_count: 0 })).toBe(false);
    spy.mockRestore();
  });
});

describe("settleJob", () => {
  it("records the attempt the job produced", async () => {
    const { client, db: store } = makeFakeSupabase(db(), CONSTRAINTS);
    const [job] = await planJobs(client, [plan()]);

    await settleJob(client, job.id, { state: "published", promoPostId: "post-9" });

    expect(store.promo_job[0].state).toBe("published");
    expect(store.promo_job[0].promo_post_id).toBe("post-9");
    expect(store.promo_job[0].locked_at).toBeNull();
  });

  it("keeps the reason a job failed", async () => {
    const { client, db: store } = makeFakeSupabase(db(), CONSTRAINTS);
    const [job] = await planJobs(client, [plan()]);

    await settleJob(client, job.id, { state: "failed", error: "rate limited" });

    expect(store.promo_job[0].state).toBe("failed");
    expect(store.promo_job[0].last_error).toBe("rate limited");
  });
});

describe("reapStalePublishingJobs", () => {
  const NOW = new Date("2026-08-19T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function publishingJob(over: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      list_id: "list-a",
      platform: "bluesky",
      state: "publishing",
      locked_at: new Date(NOW.getTime() - PUBLISH_LEASE_MS - 1000).toISOString(),
      attempt_count: 1,
      ...over,
    };
  }

  it("fails an interrupted job instead of retrying it", async () => {
    // The publish may well have landed. Re-running it would be the duplicate
    // this whole model exists to prevent, so the job is closed, not requeued.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, db: store } = makeFakeSupabase(
      db({ promo_job: [publishingJob()] }),
      CONSTRAINTS,
    );

    const result = await reapStalePublishingJobs(client);

    expect(result.reaped).toBe(1);
    expect(store.promo_job[0].state).toBe("failed");
    expect(store.promo_job[0].state).not.toBe("queued");
    expect(store.promo_job[0].last_error).toContain("outcome unknown");
    expect(store.promo_job[0].locked_at).toBeNull();
    spy.mockRestore();
  });

  it("leaves a job that is merely slow alone", async () => {
    const { client, db: store } = makeFakeSupabase(
      db({
        promo_job: [
          publishingJob({ locked_at: new Date(NOW.getTime() - 30_000).toISOString() }),
        ],
      }),
      CONSTRAINTS,
    );

    expect((await reapStalePublishingJobs(client)).reaped).toBe(0);
    expect(store.promo_job[0].state).toBe("publishing");
  });

  it("ignores jobs that are not publishing", async () => {
    const stale = new Date(NOW.getTime() - PUBLISH_LEASE_MS - 1000).toISOString();
    const { client, db: store } = makeFakeSupabase(
      db({
        promo_job: [
          publishingJob({ id: "job-q", state: "queued", locked_at: null }),
          publishingJob({ id: "job-p", state: "published", locked_at: stale }),
        ],
      }),
      CONSTRAINTS,
    );

    expect((await reapStalePublishingJobs(client)).reaped).toBe(0);
    expect(store.promo_job.map((j) => j.state)).toEqual(["queued", "published"]);
  });

  it("does not overwrite a slow worker that finished first", async () => {
    // The reaper re-checks state in the update, so a worker that settled the
    // job between the select and the write keeps its result.
    const { client, db: store } = makeFakeSupabase(
      db({ promo_job: [publishingJob()] }),
      CONSTRAINTS,
    );

    // Simulate the finish landing after the reaper's select.
    const original = client.from.bind(client);
    let selected = false;
    client.from = (table: string) => {
      const builder = original(table);
      if (table === "promo_job" && !selected) {
        const select = builder.select.bind(builder);
        builder.select = (...args: unknown[]) => {
          const chained = select(...args);
          const then = chained.then.bind(chained);
          chained.then = (onOk: any, onErr: any) =>
            then((value: any) => {
              if (!selected) {
                selected = true;
                store.promo_job[0].state = "published";
              }
              return onOk ? onOk(value) : value;
            }, onErr);
          return chained;
        };
      }
      return builder;
    };

    expect((await reapStalePublishingJobs(client)).reaped).toBe(0);
    expect(store.promo_job[0].state).toBe("published");
  });
});
