import { describe, expect, it } from "vitest";
import { Credits, memoryStore as creditMemory } from "@profullstack/redeem-credits";
import { Affiliates, memoryStore as affMemory } from "@profullstack/affiliates";
import {
  INVITE_BONUS_CREDITS,
  INVITE_MIN_ACCOUNT_AGE_DAYS,
  applyGrant,
  acceptInvite,
  canonicalEmail,
  createInvite,
  inviteOverview,
  mintCreditCode,
  redeemCreditCode,
  settleInviteBonus,
  type AuthInfo,
  type CreditDeps,
} from "@/lib/creditCodes";
import { runInvites, runRedeem } from "@/lib/creditCodesCli";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-26T12:00:00Z");

/** Just enough of supabase-js for lib/creditCodes: the grant RPC and two selects. */
function fakeDb(balances: Record<string, number>) {
  const grants = new Map<string, number>(); // `${user}|${source}` -> credits
  let failNext = 0;
  const db = {
    grants,
    balances,
    failMirror(n = 1) {
      failNext = n;
    },
    async rpc(fn: string, args: { p_user: string; p_source: string; p_credits: number }) {
      if (fn !== "grant_code_credits") return { data: null, error: { message: `no fn ${fn}` } };
      if (failNext > 0) {
        failNext--;
        return { data: null, error: { message: "connection reset" } };
      }
      const key = `${args.p_user}|${args.p_source}`;
      if (grants.has(key)) return { data: { applied: false, balance: balances[args.p_user] }, error: null };
      if (!(args.p_user in balances)) return { data: null, error: { message: "no profile" } };
      grants.set(key, args.p_credits);
      balances[args.p_user] += args.p_credits;
      return { data: { applied: true, balance: balances[args.p_user] }, error: null };
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let inList: string[] | null = null;
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => ((filters[col] = v), q),
        in: (_col: string, v: string[]) => ((inList = v), q),
        maybeSingle: async () => {
          if (table === "profiles") {
            const id = String(filters.id);
            return { data: id in balances ? { credits_balance: balances[id] } : null, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (v: { data: unknown; error: null }) => void) => {
          if (table !== "code_credit_grants") return resolve({ data: [], error: null });
          const user = String(filters.user_id);
          const rows = [...grants.keys()]
            .map((k) => k.split("|"))
            .filter(([u, s]) => u === user && (!inList || inList.includes(s)))
            .map(([, source]) => ({ source }));
          resolve({ data: rows, error: null });
        },
      };
      return q;
    },
  };
  return db;
}

function setup(users: Record<string, Partial<AuthInfo> & { balance?: number }>) {
  const balances: Record<string, number> = {};
  const auth = new Map<string, AuthInfo>();
  for (const [id, u] of Object.entries(users)) {
    balances[id] = u.balance ?? 20;
    auth.set(id, {
      email: u.email ?? `${id}@example.com`,
      confirmed: u.confirmed ?? true,
      banned: u.banned ?? false,
      createdAt: u.createdAt ?? new Date(NOW - 30 * DAY).toISOString(),
    });
  }
  const db = fakeDb(balances);
  const now = () => NOW;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  const deps: CreditDeps = {
    db: anyDb,
    credits: new Credits(creditMemory(), { now, onGrant: (u, g, s) => applyGrant(anyDb, u, g, s) }),
    affiliates: new Affiliates(affMemory(), { now, defaultQuota: 3, inviteTtlMs: 30 * DAY }),
    now,
    authUser: async (id) => auth.get(id) ?? null,
  };
  return { deps, db, balances, auth };
}

describe("credit codes", () => {
  it("writes a redeemed code into the existing balance exactly once", async () => {
    const { deps, balances } = setup({ alice: {}, bob: {} });
    const { code } = await mintCreditCode({ credits: 100, label: "test" }, deps);
    const r = await redeemCreditCode("alice", code.toLowerCase().replace(/-/g, " "), deps);
    expect(r).toMatchObject({ ok: true, credits: 100, balance: 120 });
    expect(balances.alice).toBe(120);

    const again = await redeemCreditCode("alice", code, deps);
    expect(again).toMatchObject({ ok: false, reason: "already_redeemed" });
    expect(balances.alice).toBe(120);

    const other = await redeemCreditCode("bob", code, deps);
    expect(other).toMatchObject({ ok: false, reason: "used_up" });
    expect(balances.bob).toBe(20);
  });

  it("rejects unknown codes", async () => {
    const { deps } = setup({ alice: {} });
    expect(await redeemCreditCode("alice", "CR-0000-0000-0000-0000", deps)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("repairs a mirror write that failed after the redemption committed", async () => {
    const { deps, db, balances } = setup({ alice: {} });
    const { code } = await mintCreditCode({ credits: 40 }, deps);
    db.failMirror(1);
    await expect(redeemCreditCode("alice", code, deps)).rejects.toThrow(/grant_code_credits/);
    expect(balances.alice).toBe(20);
    // Retrying answers already_redeemed but re-applies the missing grant once.
    expect(await redeemCreditCode("alice", code, deps)).toMatchObject({ ok: false, reason: "already_redeemed" });
    expect(balances.alice).toBe(60);
    await redeemCreditCode("alice", code, deps);
    expect(balances.alice).toBe(60);
  });

  it("validates mint input", async () => {
    const { deps } = setup({});
    await expect(mintCreditCode({ credits: 0 }, deps)).rejects.toThrow(TypeError);
    await expect(mintCreditCode({ credits: 1.5 }, deps)).rejects.toThrow(TypeError);
    await expect(mintCreditCode({ credits: 10, maxRedemptions: 0 }, deps)).rejects.toThrow(TypeError);
  });
});

describe("invites", () => {
  const fresh = () => new Date(NOW - 1 * DAY).toISOString();

  it("locks invites for new and unconfirmed accounts", async () => {
    const { deps } = setup({
      young: { createdAt: new Date(NOW - (INVITE_MIN_ACCOUNT_AGE_DAYS - 1) * DAY).toISOString() },
      unconfirmed: { confirmed: false },
      junk: { email: "x@mailinator.com" },
    });
    await expect(createInvite("young", "", deps)).rejects.toMatchObject({ reason: "too_new" });
    await expect(createInvite("unconfirmed", "", deps)).rejects.toMatchObject({ reason: "unconfirmed" });
    await expect(createInvite("junk", "", deps)).rejects.toMatchObject({ reason: "blocked" });
  });

  it("pays both sides once, only after the invitee confirms", async () => {
    const { deps, balances, auth } = setup({ alice: {}, carol: { createdAt: fresh(), confirmed: false } });
    const inv = await createInvite("alice", "for carol", deps);
    expect((await deps.affiliates.quota("alice")).left).toBe(2);

    const r = await acceptInvite("carol", inv.code, deps);
    expect(r).toMatchObject({ ok: true, bonus: "pending", pendingReason: "email not confirmed" });
    expect(balances.alice).toBe(20);
    expect(balances.carol).toBe(20);

    auth.get("carol")!.confirmed = true;
    expect(await settleInviteBonus("carol", deps)).toMatchObject({ status: "granted" });
    expect(balances.alice).toBe(20 + INVITE_BONUS_CREDITS);
    expect(balances.carol).toBe(20 + INVITE_BONUS_CREDITS);

    expect(await settleInviteBonus("carol", deps)).toMatchObject({ status: "already" });
    expect(balances.alice).toBe(20 + INVITE_BONUS_CREDITS);

    const o = await inviteOverview("alice", deps);
    expect(o.invites[0]).toMatchObject({ status: "used", bonus: "granted" });
    expect(o.invites[0].usedByEmail).toMatch(/^ca\*+@example\.com$/);
  });

  it("holds the bonus for disposable or same-inbox invitees", async () => {
    const { deps, balances } = setup({
      alice: { email: "alice.smith@gmail.com" },
      sock: { email: "alicesmith+2@gmail.com", createdAt: fresh() },
      temp: { email: "t@yopmail.com", createdAt: fresh() },
    });
    const a = await createInvite("alice", "", deps);
    const b = await createInvite("alice", "", deps);
    expect(await acceptInvite("sock", a.code, deps)).toMatchObject({ ok: true, bonus: "pending", pendingReason: "same person" });
    expect(await acceptInvite("temp", b.code, deps)).toMatchObject({ ok: true, bonus: "pending", pendingReason: "disposable email" });
    expect(balances.alice).toBe(20);
    expect(balances.sock).toBe(20);
    expect(balances.temp).toBe(20);
  });

  it("refuses old accounts, self-use and a second invite", async () => {
    const { deps } = setup({ alice: {}, bob: {}, dan: { createdAt: fresh() } });
    const a = await createInvite("alice", "", deps);
    const b = await createInvite("bob", "", deps);
    expect(await acceptInvite("bob", a.code, deps)).toMatchObject({ ok: false, reason: "not_new" });
    expect(await acceptInvite("dan", a.code, deps)).toMatchObject({ ok: true });
    expect(await acceptInvite("dan", b.code, deps)).toMatchObject({ ok: false, reason: "already_invited" });
    const c = await createInvite("alice", "", deps);
    // Alice is not new, so not_new is checked first; self-use is refused by the store either way.
    expect((await acceptInvite("alice", c.code, deps)).ok).toBe(false);
  });

  it("canonicalizes gmail aliases", () => {
    expect(canonicalEmail("A.Lice+x@GoogleMail.com")).toBe("alice@gmail.com");
    expect(canonicalEmail("a.lice+x@example.com")).toBe("a.lice@example.com");
  });
});

describe("cli", () => {
  const out = () => {
    const lines: string[] = [];
    const errs: string[] = [];
    return { lines, errs, o: { write: (l: string) => lines.push(l), error: (l: string) => errs.push(l) } };
  };

  it("redeem posts the code and prints the balance", async () => {
    const { lines, o } = out();
    const calls: unknown[] = [];
    const code = await runRedeem(["CR-1"], {}, async (m, p, b) => {
      calls.push([m, p, b]);
      return { status: 200, json: { message: "Code redeemed: 5 credits added.", balance: 25 } };
    }, o);
    expect(code).toBe(0);
    expect(calls).toEqual([["POST", "/api/credits/redeem", { code: "CR-1" }]]);
    expect(lines[0]).toContain("Balance: 25");
  });

  it("redeem exits 1 on a refused code", async () => {
    const { errs, o } = out();
    const code = await runRedeem(["CR-1"], {}, async () => ({ status: 400, json: { error: "That code has expired." } }), o);
    expect(code).toBe(1);
    expect(errs[0]).toContain("expired");
  });

  it("invites create and accept hit the right routes", async () => {
    const { lines, o } = out();
    const seen: string[] = [];
    const call = async (m: string, p: string) => {
      seen.push(`${m} ${p}`);
      return { status: 200, json: { url: "https://crawlproof.com/i/INV-1", code: "INV-1", message: "Invite accepted." } };
    };
    expect(await runInvites(["create"], { note: "x" }, call, o)).toBe(0);
    expect(await runInvites(["accept", "INV-1"], {}, call, o)).toBe(0);
    expect(seen).toEqual(["POST /api/invites", "POST /api/invites/accept"]);
    expect(lines.join("\n")).toContain("https://crawlproof.com/i/INV-1");
  });
});
