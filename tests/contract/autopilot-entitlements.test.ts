import { describe, expect, it } from "vitest";
import {
  consumeArticleGenerationCharge,
  getArticleGenerationCapacity,
  getCurrentProjectEntitlement,
  refundArticleGenerationCharge,
} from "@/lib/autopilot/entitlements";

type TableName = "project_entitlements" | "subscriptions" | "profiles";

type EntitlementRow = {
  id: string;
  project_id: string;
  subscription_id: string | null;
  period_start: string;
  period_end: string;
  articles_included: number;
  articles_used: number;
  prompts_included: number;
  prompts_used: number;
  fix_prs_included: number;
  fix_prs_used: number;
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  status: string;
};

type ProfileRow = { id: string; credits_balance: number };

class Query<T extends Record<string, any>> implements PromiseLike<{ data: T[]; error: null }> {
  private filters: Array<(row: T) => boolean> = [];
  private maxRows: number | null = null;

  constructor(private rows: T[]) {}

  select() {
    return this;
  }

  eq(key: keyof T & string, value: unknown) {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  lte(key: keyof T & string, value: string) {
    this.filters.push((row) => String(row[key]) <= value);
    return this;
  }

  gt(key: keyof T & string, value: string) {
    this.filters.push((row) => String(row[key]) > value);
    return this;
  }

  in(key: keyof T & string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[key]));
    return this;
  }

  order() {
    return this;
  }

  limit(n: number) {
    this.maxRows = n;
    return this;
  }

  maybeSingle(): Promise<{ data: T | null; error: null }> {
    return Promise.resolve({ data: this.apply()[0] ?? null, error: null });
  }

  then<TResult1 = { data: T[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: T[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.apply(), error: null }).then(onfulfilled, onrejected);
  }

  private apply(): T[] {
    let out = this.rows.filter((row) => this.filters.every((fn) => fn(row)));
    if (this.maxRows !== null) out = out.slice(0, this.maxRows);
    return out;
  }
}

class FakeSupabase {
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(
    private tables: {
      project_entitlements?: EntitlementRow[];
      subscriptions?: SubscriptionRow[];
      profiles?: ProfileRow[];
    },
    private rpcResults: Record<string, unknown> = {},
  ) {}

  from(name: TableName) {
    return new Query((this.tables[name] ?? []) as any[]);
  }

  rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    return Promise.resolve({ data: this.rpcResults[name] ?? null, error: null });
  }
}

const now = "2026-06-06T12:00:00.000Z";

const entitlement = (overrides: Partial<EntitlementRow> = {}): EntitlementRow => ({
  id: "ent-1",
  project_id: "project-1",
  subscription_id: "sub-1",
  period_start: "2026-06-01T00:00:00.000Z",
  period_end: "2026-07-01T00:00:00.000Z",
  articles_included: 30,
  articles_used: 12,
  prompts_included: 25,
  prompts_used: 3,
  fix_prs_included: 5,
  fix_prs_used: 1,
  ...overrides,
});

describe("Autopilot entitlement helpers", () => {
  it("returns the active subscription entitlement with remaining article quota", async () => {
    const supabase = new FakeSupabase({
      project_entitlements: [entitlement()],
      subscriptions: [{ id: "sub-1", user_id: "owner-1", status: "active" }],
    }) as any;

    const current = await getCurrentProjectEntitlement(
      supabase,
      "project-1",
      "owner-1",
      now,
    );

    expect(current?.source).toBe("subscription");
    expect(current?.articlesRemaining).toBe(18);
    expect(current?.promptsIncluded).toBe(25);
  });

  it("falls back to manual entitlements when no active subscription matches", async () => {
    const supabase = new FakeSupabase({
      project_entitlements: [
        entitlement({ id: "sub-ent", subscription_id: "sub-1", articles_used: 4 }),
        entitlement({ id: "manual-ent", subscription_id: null, articles_used: 2 }),
      ],
      subscriptions: [{ id: "sub-1", user_id: "other-owner", status: "active" }],
    }) as any;

    const current = await getCurrentProjectEntitlement(
      supabase,
      "project-1",
      "owner-1",
      now,
    );

    expect(current?.source).toBe("manual");
    expect(current?.id).toBe("manual-ent");
    expect(current?.articlesRemaining).toBe(28);
  });

  it("reports entitlement capacity before checking credits", async () => {
    const supabase = new FakeSupabase({
      project_entitlements: [entitlement({ articles_used: 29 })],
      subscriptions: [{ id: "sub-1", user_id: "owner-1", status: "active" }],
      profiles: [{ id: "owner-1", credits_balance: 0 }],
    }) as any;

    const capacity = await getArticleGenerationCapacity(
      supabase,
      "project-1",
      "owner-1",
      now,
    );

    expect(capacity.ok).toBe(true);
    expect(capacity.source).toBe("entitlement");
    expect(capacity.entitlement?.articlesRemaining).toBe(1);
  });

  it("falls back to credit capacity when included articles are exhausted", async () => {
    const supabase = new FakeSupabase({
      project_entitlements: [entitlement({ articles_used: 30 })],
      subscriptions: [{ id: "sub-1", user_id: "owner-1", status: "active" }],
      profiles: [{ id: "owner-1", credits_balance: 60 }],
    }) as any;

    const capacity = await getArticleGenerationCapacity(
      supabase,
      "project-1",
      "owner-1",
      now,
    );

    expect(capacity.ok).toBe(true);
    expect(capacity.source).toBe("credit");
    expect(capacity.creditsBalance).toBe(60);
  });

  it("maps article generation charge RPC results and refund RPC args", async () => {
    const supabase = new FakeSupabase(
      {},
      {
        consume_article_generation: "entitlement",
        refund_article_entitlement: true,
      },
    ) as any;

    await expect(
      consumeArticleGenerationCharge(supabase, "project-1", "owner-1"),
    ).resolves.toBe("entitlement");

    await refundArticleGenerationCharge(supabase, {
      projectId: "project-1",
      ownerId: "owner-1",
      source: "entitlement",
    });

    expect(supabase.rpcCalls).toEqual([
      {
        name: "consume_article_generation",
        args: { p_project: "project-1", p_owner: "owner-1" },
      },
      {
        name: "refund_article_entitlement",
        args: { p_project: "project-1", p_owner: "owner-1" },
      },
    ]);
  });
});

