import { beforeEach, describe, expect, it, vi } from "vitest";
import { _clearMemberCache, authCookies, authenticateMember, isPayingMember, type MemberStore } from "@/lib/crawl-member";

const store = (over: Partial<{ admin: boolean; plan: string; purchase: boolean; pass: boolean }> = {}): MemberStore => ({
  profile: async () => ({ is_admin: over.admin ?? false, plan: over.plan ?? "free" }),
  hasCompletedPurchase: async () => over.purchase ?? false,
  passActive: async () => over.pass ?? false,
});

const req = (cookie?: string) =>
  new Request("https://crawlproof.com/rankings/x", { headers: cookie ? { cookie } : {} });

describe("isPayingMember", () => {
  it("passes admins, pro/team, pass holders and credit buyers", async () => {
    expect(await isPayingMember(store({ admin: true }), "u")).toBe(true);
    expect(await isPayingMember(store({ plan: "pro" }), "u")).toBe(true);
    expect(await isPayingMember(store({ plan: "team" }), "u")).toBe(true);
    expect(await isPayingMember(store({ pass: true }), "u")).toBe(true);
    expect(await isPayingMember(store({ purchase: true }), "u")).toBe(true);
  });
  it("does not pass a free account", async () => {
    expect(await isPayingMember(store(), "u")).toBe(false);
  });
});

describe("authCookies", () => {
  it("keeps only Supabase auth cookies, chunked or not", () => {
    expect(authCookies("a=1; sb-abc-auth-token.0=x; sb-abc-auth-token.1=y; sb-abc-auth-token-code-verifier=z").map((c) => c.name))
      .toEqual(["sb-abc-auth-token.0", "sb-abc-auth-token.1"]);
  });
});

describe("authenticateMember", () => {
  beforeEach(() => _clearMemberCache());

  it("answers null without a session cookie and never verifies", async () => {
    const getUserId = vi.fn();
    expect(await authenticateMember(req("foo=bar"), { getUserId })).toBeNull();
    expect(getUserId).not.toHaveBeenCalled();
  });

  it("answers null (never false) when the session does not verify", async () => {
    expect(await authenticateMember(req("sb-abc-auth-token=forged"), { getUserId: async () => null, store: store({ admin: true }) })).toBeNull();
  });

  it("answers true for a verified paying member", async () => {
    expect(await authenticateMember(req("sb-abc-auth-token=ok"), { getUserId: async () => "u1", store: store({ admin: true }) })).toBe(true);
  });

  it("answers null for a verified free member", async () => {
    expect(await authenticateMember(req("sb-abc-auth-token=free"), { getUserId: async () => "u2", store: store() })).toBeNull();
  });

  it("caches the verdict for a minute per session", async () => {
    let t = 0;
    const getUserId = vi.fn(async () => "u3");
    const deps = { getUserId, store: store({ plan: "pro" }), now: () => t };
    await authenticateMember(req("sb-abc-auth-token=c"), deps);
    t = 59_000;
    await authenticateMember(req("sb-abc-auth-token=c"), deps);
    expect(getUserId).toHaveBeenCalledTimes(1);
    t = 61_000;
    await authenticateMember(req("sb-abc-auth-token=c"), deps);
    expect(getUserId).toHaveBeenCalledTimes(2);
  });

  it("swallows errors as null", async () => {
    expect(await authenticateMember(req("sb-abc-auth-token=e"), { getUserId: async () => { throw new Error("down"); } })).toBeNull();
  });
});
