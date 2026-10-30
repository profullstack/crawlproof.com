import { beforeEach, describe, expect, it } from "vitest";
import {
  PLACEHOLDER_EMAIL_DOMAIN,
  authorizeUrl,
  checkIdToken,
  decodePending,
  disconnectCoinpay,
  encodePending,
  fetchCoinpayClaims,
  isPlaceholderEmail,
  newPendingAuth,
  placeholderEmail,
  resolveCoinpayUser,
  safeNext,
  stateMatches,
  type CoinpayConfig,
  type CoinpayStore,
  type IdentityRow,
} from "../lib/coinpay-signin";

const CFG: CoinpayConfig = { clientId: "cp_test", clientSecret: "cps_test", issuer: "https://coinpayportal.com", siteUrl: "https://crawlproof.com" };

/** In-memory auth users + identities. Users carry the email they signed up with. */
function memory() {
  const users = new Map<string, { email: string }>([["victim", { email: "victim@example.com" }]]);
  const ids: (IdentityRow & { coinpay_name: string | null })[] = [];
  let n = 0;
  const store: CoinpayStore = {
    async identityBySub(sub) {
      return ids.find((i) => i.coinpay_sub === sub) ?? null;
    },
    async identityByUser(u) {
      return ids.find((i) => i.user_id === u) ?? null;
    },
    async link(row) {
      if (ids.some((i) => i.coinpay_sub === row.coinpay_sub || i.user_id === row.user_id)) return "conflict";
      ids.push(row);
      return "ok";
    },
    async unlink(u) {
      const i = ids.findIndex((x) => x.user_id === u);
      if (i >= 0) ids.splice(i, 1);
    },
    async touch() {},
    async createUser() {
      const id = `new-${++n}`;
      users.set(id, { email: placeholderEmail() });
      return id;
    },
    async deleteUser(u) {
      users.delete(u);
    },
  };
  return { store, users, ids };
}

let db: ReturnType<typeof memory>;
beforeEach(() => {
  db = memory();
});

describe("STANDING rule: bind by CoinPay sub, never by email", () => {
  it("a CoinPay login carrying an existing user's email does NOT get that user's account", async () => {
    const r = await resolveCoinpayUser(
      { mode: "login", currentUserId: null, claims: { sub: "attacker-sub", email: "victim@example.com", name: "Mallory" } },
      db.store,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("created");
    expect(r.userId).not.toBe("victim");
    // The new account's auth email is a random placeholder, not the CoinPay email.
    const created = db.users.get(r.userId)!;
    expect(created.email).not.toBe("victim@example.com");
    expect(isPlaceholderEmail(created.email)).toBe(true);
    // And the victim was not linked to anything.
    expect(await db.store.identityByUser("victim")).toBeNull();
    // The CoinPay email lives on the identity row only, as contact info.
    expect((await db.store.identityBySub("attacker-sub"))!.coinpay_email).toBe("victim@example.com");
  });

  it("a second login with the same sub gets the same account", async () => {
    const a = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "s1", email: null, name: null } }, db.store);
    const b = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "s1", email: "other@example.com", name: null } }, db.store);
    expect(a.ok && b.ok && a.userId === b.userId).toBe(true);
    expect(b.ok && b.action).toBe("login");
  });

  it("after Connect, a CoinPay login reaches the connected account", async () => {
    const c = await resolveCoinpayUser({ mode: "connect", currentUserId: "victim", claims: { sub: "victim-sub", email: "x@y.z", name: null } }, db.store);
    expect(c).toEqual({ ok: true, userId: "victim", action: "linked" });
    const l = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "victim-sub", email: null, name: null } }, db.store);
    expect(l).toEqual({ ok: true, userId: "victim", action: "login" });
  });

  it("linking requires a signed-in session", async () => {
    const r = await resolveCoinpayUser({ mode: "connect", currentUserId: null, claims: { sub: "s", email: "victim@example.com", name: null } }, db.store);
    expect(r).toMatchObject({ ok: false, code: "not_signed_in" });
    expect(db.ids).toHaveLength(0);
  });

  it("a sub already linked elsewhere cannot be connected to another account", async () => {
    await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "s", email: null, name: null } }, db.store);
    const r = await resolveCoinpayUser({ mode: "connect", currentUserId: "victim", claims: { sub: "s", email: null, name: null } }, db.store);
    expect(r).toMatchObject({ ok: false, code: "linked_elsewhere" });
  });

  it("an account already connected to one CoinPay account refuses a second", async () => {
    await resolveCoinpayUser({ mode: "connect", currentUserId: "victim", claims: { sub: "s1", email: null, name: null } }, db.store);
    const r = await resolveCoinpayUser({ mode: "connect", currentUserId: "victim", claims: { sub: "s2", email: null, name: null } }, db.store);
    expect(r).toMatchObject({ ok: false, code: "already_connected" });
  });

  it("a lost first-login race keeps the winner and deletes the orphan", async () => {
    const racing: CoinpayStore = {
      ...db.store,
      async identityBySub(sub) {
        return calls++ === 0 ? null : db.store.identityBySub(sub);
      },
    };
    let calls = 0;
    db.ids.push({ user_id: "winner", coinpay_sub: "s", coinpay_email: null, coinpay_name: null, created_via: "signup" });
    const r = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "s", email: null, name: null } }, racing);
    expect(r).toEqual({ ok: true, userId: "winner", action: "login" });
    expect([...db.users.keys()]).toEqual(["victim"]);
  });
});

describe("disconnect", () => {
  it("is refused when CoinPay is the only way in", async () => {
    const r = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "s", email: null, name: null } }, db.store);
    const uid = (r as { userId: string }).userId;
    const d = await disconnectCoinpay(uid, db.users.get(uid)!.email, db.store);
    expect(d.ok).toBe(false);
    expect(db.ids).toHaveLength(1);
  });

  it("works for an account with its own email", async () => {
    await resolveCoinpayUser({ mode: "connect", currentUserId: "victim", claims: { sub: "s", email: null, name: null } }, db.store);
    expect(await disconnectCoinpay("victim", "victim@example.com", db.store)).toEqual({ ok: true });
    expect(db.ids).toHaveLength(0);
  });
});

describe("state, nonce and PKCE", () => {
  it("authorize URL carries PKCE S256, state, nonce and the exact redirect", () => {
    const p = newPendingAuth("login", "/dashboard/fleet");
    const u = new URL(authorizeUrl(CFG, p));
    expect(u.origin + u.pathname).toBe("https://coinpayportal.com/api/oauth/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(p.challenge);
    expect(u.searchParams.get("state")).toBe(p.state);
    expect(u.searchParams.get("nonce")).toBe(p.nonce);
    expect(u.searchParams.get("redirect_uri")).toBe("https://crawlproof.com/api/v1/coinpay/oauth/callback");
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    expect(u.searchParams.get("client_id")).toBe("cp_test");
  });

  it("round-trips the pending cookie and rejects junk", () => {
    const p = newPendingAuth("connect", "/dashboard/settings");
    const back = decodePending(encodePending(p))!;
    expect(back).toEqual({ state: p.state, verifier: p.verifier, nonce: p.nonce, mode: "connect", next: "/dashboard/settings" });
    expect(decodePending("not-base64-json")).toBeNull();
    expect(decodePending(undefined)).toBeNull();
  });

  it("rejects a bad or missing state", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", null)).toBe(false);
    expect(stateMatches(null, "abc")).toBe(false);
  });

  it("only redirects to same-site paths", () => {
    expect(safeNext("/dashboard/fleet")).toBe("/dashboard/fleet");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", ""]) {
      expect(safeNext(bad)).toBe("/dashboard");
    }
  });
});

const jwt = (claims: Record<string, unknown>) =>
  ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("ID token checks", () => {
  const good = { iss: "https://coinpayportal.com", aud: "cp_test", sub: "s1", nonce: "n1", exp: Math.floor(Date.now() / 1000) + 600 };
  const want = { issuer: CFG.issuer, clientId: CFG.clientId, nonce: "n1", sub: "s1" };
  it("accepts a matching token", () => {
    expect(checkIdToken(jwt(good), want)).toEqual({ ok: true });
  });
  it("rejects a bad nonce, audience, issuer, subject, expiry or no token", () => {
    expect(checkIdToken(jwt({ ...good, nonce: "other" }), want)).toMatchObject({ ok: false, error: "nonce mismatch" });
    expect(checkIdToken(jwt({ ...good, nonce: undefined }), want)).toMatchObject({ ok: false, error: "nonce mismatch" });
    expect(checkIdToken(jwt({ ...good, aud: "cp_other" }), want).ok).toBe(false);
    expect(checkIdToken(jwt({ ...good, iss: "https://evil.example" }), want).ok).toBe(false);
    expect(checkIdToken(jwt({ ...good, sub: "s2" }), want).ok).toBe(false);
    expect(checkIdToken(jwt({ ...good, exp: 1000 }), want).ok).toBe(false);
    expect(checkIdToken(undefined, want).ok).toBe(false);
  });

  it("fetchCoinpayClaims refuses a token whose nonce does not match", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith("/api/oauth/token")) {
        const body = new URLSearchParams(String(init.body));
        expect(body.get("code_verifier")).toBe("v");
        expect(body.get("client_secret")).toBe("cps_test");
        return Response.json({ access_token: "at", id_token: jwt({ ...good, nonce: "attacker" }) });
      }
      return Response.json({ sub: "s1", email: "victim@example.com", email_verified: false });
    }) as unknown as typeof fetch;
    const r = await fetchCoinpayClaims(CFG, { code: "c", verifier: "v", nonce: "n1" }, fake);
    expect(r).toEqual({ ok: false, error: "nonce mismatch" });
    expect(calls).toHaveLength(2);
  });

  it("fetchCoinpayClaims returns sub, email and name on success", async () => {
    const fake = (async (url: string) =>
      String(url).endsWith("/token")
        ? Response.json({ access_token: "at", id_token: jwt(good) })
        : Response.json({ sub: "s1", email: "a@b.co", name: "Ann" })) as unknown as typeof fetch;
    expect(await fetchCoinpayClaims(CFG, { code: "c", verifier: "v", nonce: "n1" }, fake)).toEqual({
      ok: true,
      claims: { sub: "s1", email: "a@b.co", name: "Ann" },
    });
  });
});

describe("placeholder emails", () => {
  it("are random and under the placeholder domain", () => {
    const a = placeholderEmail();
    expect(a.endsWith("@" + PLACEHOLDER_EMAIL_DOMAIN)).toBe(true);
    expect(a).not.toBe(placeholderEmail());
    expect(isPlaceholderEmail("ann@example.com")).toBe(false);
  });
});

it("imports wallet metadata only after validating the OAuth subject and never returns bearer tokens", async () => {
  const good = { iss: CFG.issuer, aud: CFG.clientId, sub: "s1", nonce: "n1", exp: Math.floor(Date.now()/1000)+600 };
  const fake = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/token")) return Response.json({ access_token: "fixture-access", id_token: jwt(good) });
    if (url.endsWith("/userinfo")) return Response.json({ sub: "s1" });
    expect(url).toBe("https://coinpayportal.com/api/wallets?source=all");
    expect((init.headers as Record<string,string>).authorization).toBe("Bearer fixture-access");
    return Response.json({ wallets: [{ id: "global", source: "account", is_active: true, cryptocurrency: "USDC_POL", wallet_address: "0xGlobal" }] });
  }) as typeof fetch;
  const result = await fetchCoinpayClaims(CFG,{code:"c",verifier:"v",nonce:"n1",wallets:true},fake);
  expect(result).toMatchObject({ok:true,wallets:[{currency:"usdc_pol",address:"0xGlobal"}]});
  expect(JSON.stringify(result)).not.toContain("fixture-access");
});
