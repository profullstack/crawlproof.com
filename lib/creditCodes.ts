/**
 * Redeemable credit codes and scarce invites (server only).
 *
 * - A credit code (@profullstack/redeem-credits, `CR-XXXX-XXXX-XXXX-XXXX`) grants
 *   scan credits. An admin mints it and hands it to someone; they redeem it on
 *   /dashboard/settings/billing ("Have a code?"), with POST /api/credits/redeem,
 *   `crawlproof redeem <code>` or the `redeem_credit_code` MCP tool.
 * - An invite (@profullstack/affiliates, `INV-XXXX-XXXX-XXXX`) is scarce: every
 *   account gets INVITE_QUOTA. When a NEW account joins on one, both people get
 *   INVITE_BONUS_CREDITS, but only once the new account has confirmed its email
 *   and passes crawlproof's existing abuse checks (not banned, not a disposable
 *   address from lib/alerts/validate, not the inviter under another alias).
 *
 * There is exactly one balance: profiles.credits_balance. redeem-credits keeps
 * the codes (sha256 only) and an audit row per redemption in credit_ledger; the
 * scan credits themselves are written into profiles.credits_balance through the
 * grant_code_credits() RPC, which is idempotent on (user, source) via the
 * code_credit_grants primary key. A code's source is `code:<codeId>`, an invite
 * bonus's is `invite:<inviteId>:<inviter|invitee>`.
 *
 * Affiliates: crawlproof's open affiliate link is OpenAffiliate (?oa=, the oa
 * cookie, affiliate_attributions). This module never calls attribute() and
 * never mints an aff_codes link, so a signup is never counted twice.
 *
 * Clients are built lazily, so env vars are read at runtime, not inlined at build.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { Credits, supabaseStore as creditStore, type Grant } from "@profullstack/redeem-credits";
import { Affiliates, supabaseStore as affiliateStore } from "@profullstack/affiliates";
import { serviceClient } from "@/lib/supabase/service";
import { isDisposableEmail } from "@/lib/alerts/validate";

/** The only unit crawlproof codes grant. */
export const SCAN_CREDITS_UNIT = "scan_credits";
/** Invites every account may create (an admin can raise one user's with setQuota). */
export const INVITE_QUOTA = 3;
/** Credits each side gets when an invited account qualifies (one AI-model scan). */
export const INVITE_BONUS_CREDITS = 20;
/** An account can hand out invites once it is this old (stops sock-puppet chains). */
export const INVITE_MIN_ACCOUNT_AGE_DAYS = 3;
/** Only accounts at most this old can accept an invite: invites are for new people. */
export const INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS = 7;
/** Invite codes expire after this many days. */
export const INVITE_TTL_DAYS = 30;
/** Cookie /i/<code> sets so the code survives the trip through signup. */
export const INVITE_COOKIE = "cp_invite";
/** Largest grant one code may carry. */
export const MAX_CODE_CREDITS = 100_000;

const DAY_MS = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any>;

export type AuthInfo = {
  email: string | null;
  confirmed: boolean;
  banned: boolean;
  createdAt: string | null;
};

export type CreditDeps = {
  db: Db;
  credits: Credits;
  affiliates: Affiliates;
  now: () => number;
  /** auth.users facts for a user (service role admin API). */
  authUser: (userId: string) => Promise<AuthInfo | null>;
};

async function adminAuthUser(db: Db, userId: string, now: number): Promise<AuthInfo | null> {
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data?.user) return null;
  const u = data.user as {
    email?: string | null;
    email_confirmed_at?: string | null;
    confirmed_at?: string | null;
    banned_until?: string | null;
    created_at?: string | null;
    deleted_at?: string | null;
  };
  const bannedUntil = u.banned_until ? new Date(u.banned_until).getTime() : 0;
  return {
    email: u.email ?? null,
    confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
    banned: Boolean(u.deleted_at) || bannedUntil > now,
    createdAt: u.created_at ?? null,
  };
}

/** Build the services over a supabase-js service-role client. */
export function buildCreditDeps(db: Db, now: () => number = Date.now): CreditDeps {
  const credits = new Credits(creditStore(db), {
    now,
    onGrant: async (userId: string, grant: Grant, source: string) => {
      await applyGrant(db, userId, grant, source);
    },
  });
  const affiliates = new Affiliates(affiliateStore(db), {
    now,
    defaultQuota: INVITE_QUOTA,
    inviteTtlMs: INVITE_TTL_DAYS * DAY_MS,
  });
  return { db, credits, affiliates, now, authUser: (id) => adminAuthUser(db, id, now()) };
}

let _deps: CreditDeps | undefined;
export function getCreditDeps(): CreditDeps {
  return (_deps ??= buildCreditDeps(serviceClient()));
}

/** Test hook. */
export function setCreditDepsForTest(deps: CreditDeps | undefined) {
  _deps = deps;
}

/**
 * Write credits into profiles.credits_balance, once per (user, source).
 * Returns whether this call applied them and the balance afterwards.
 */
export async function grantCreditsOnce(
  db: Db,
  userId: string,
  credits: number,
  source: string,
): Promise<{ applied: boolean; balance: number | null }> {
  const { data, error } = await db.rpc("grant_code_credits", {
    p_user: userId,
    p_source: source,
    p_credits: credits,
  });
  if (error) throw new Error(`grant_code_credits: ${error.message}`);
  const row = (data ?? {}) as { applied?: boolean; balance?: number | null };
  return { applied: Boolean(row.applied), balance: row.balance ?? null };
}

/** onGrant: mirror one committed redeem-credits grant into the existing balance. */
export async function applyGrant(db: Db, userId: string, grant: Grant, source: string) {
  if (grant.unit !== SCAN_CREDITS_UNIT || grant.every) {
    // Only one-off scan_credits codes are minted here; anything else is a bug.
    console.error("[credits] grant with an unsupported unit ignored", { userId, unit: grant.unit, source });
    return;
  }
  const amount = Math.trunc(grant.amount);
  if (amount < 1) return;
  await grantCreditsOnce(db, userId, amount, source);
}

// ── Credit codes ─────────────────────────────────────────────────────

export type RedeemFailure = "invalid" | "expired" | "used_up" | "already_redeemed" | "revoked";

export const REDEEM_MESSAGES: Record<RedeemFailure, string> = {
  invalid: "That code is not valid. Check it and try again.",
  expired: "That code has expired.",
  used_up: "That code has already been used.",
  already_redeemed: "You have already redeemed that code.",
  revoked: "That code is no longer valid.",
};

async function balanceOf(db: Db, userId: string): Promise<number | null> {
  const { data } = await db.from("profiles").select("credits_balance").eq("id", userId).maybeSingle();
  return (data as { credits_balance: number } | null)?.credits_balance ?? null;
}

/**
 * Re-apply any code grant whose mirror write did not land (the hook threw after
 * the redemption committed). Idempotent; cheap (one history read).
 */
export async function repairCodeGrants(userId: string, deps: CreditDeps = getCreditDeps()): Promise<number> {
  let fixed = 0;
  for (const e of await deps.credits.history(userId, SCAN_CREDITS_UNIT)) {
    if (e.kind !== "grant" || !e.source.startsWith("code:")) continue;
    const r = await grantCreditsOnce(deps.db, userId, Math.trunc(e.amount), e.source);
    if (r.applied) fixed++;
  }
  return fixed;
}

export async function redeemCreditCode(
  userId: string,
  code: string,
  deps: CreditDeps = getCreditDeps(),
): Promise<
  | { ok: true; credits: number; balance: number | null }
  | { ok: false; reason: RedeemFailure; message: string }
> {
  const input = String(code ?? "").trim().slice(0, 64);
  const r = await deps.credits.redeem(input, userId);
  if (!r.ok) {
    if (r.reason === "already_redeemed") await repairCodeGrants(userId, deps).catch(() => 0);
    return { ok: false, reason: r.reason, message: REDEEM_MESSAGES[r.reason] };
  }
  return { ok: true, credits: r.grant.amount, balance: await balanceOf(deps.db, userId) };
}

export async function mintCreditCode(
  o: { credits: number; label?: string; maxRedemptions?: number; expiresAt?: number | null; createdBy?: string },
  deps: CreditDeps = getCreditDeps(),
) {
  if (!Number.isInteger(o.credits) || o.credits < 1 || o.credits > MAX_CODE_CREDITS) {
    throw new TypeError(`credits must be a whole number from 1 to ${MAX_CODE_CREDITS}`);
  }
  const max = o.maxRedemptions ?? 1;
  if (!Number.isInteger(max) || max < 1 || max > 10_000) {
    throw new TypeError("maxRedemptions must be a whole number from 1 to 10000");
  }
  return deps.credits.mint({
    grant: { unit: SCAN_CREDITS_UNIT, amount: o.credits },
    label: (o.label ?? `${o.credits} CrawlProof credits`).slice(0, 200),
    maxRedemptions: max,
    expiresAt: o.expiresAt ?? null,
    createdBy: o.createdBy,
  });
}

// ── Abuse checks (crawlproof's existing guards) ──────────────────────

/** Lowercase, and for Gmail drop dots and +tags, so aliases of one inbox match. */
export function canonicalEmail(email: string | null | undefined): string {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/** First reason an account may not take part in invites, or null. */
export function abuseReason(auth: AuthInfo | null): string | null {
  if (!auth) return "no account";
  if (auth.banned) return "account banned";
  if (!auth.email) return "no email";
  if (!auth.confirmed) return "email not confirmed";
  if (isDisposableEmail(auth.email)) return "disposable email";
  return null;
}

function ageDays(createdAt: string | null | undefined, now: number): number {
  if (!createdAt) return 0;
  return (now - new Date(createdAt).getTime()) / DAY_MS;
}

// ── Invites ──────────────────────────────────────────────────────────

export type InviteRow = {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  usedBy: string | null;
  usedAt: number | null;
  note: string;
  revokedAt: number | null;
  status: "open" | "used" | "expired" | "revoked";
  usedByEmail?: string | null;
  bonus?: "granted" | "pending";
};

export function inviteSource(inviteId: string, side: "inviter" | "invitee") {
  return `invite:${inviteId}:${side}`;
}

async function grantedSources(db: Db, userId: string, sources: string[]): Promise<Set<string>> {
  if (!sources.length) return new Set();
  const { data } = await db
    .from("code_credit_grants")
    .select("source")
    .eq("user_id", userId)
    .in("source", sources);
  return new Set(((data ?? []) as { source: string }[]).map((r) => r.source));
}

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return null;
  return `${local.slice(0, 2)}${"*".repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

export async function inviteOverview(userId: string, deps: CreditDeps = getCreditDeps()) {
  const now = deps.now();
  const [quota, raw, auth] = await Promise.all([
    deps.affiliates.quota(userId),
    deps.affiliates.invites(userId),
    deps.authUser(userId),
  ]);
  const usedIds = raw.map((i) => i.usedBy).filter((u): u is string => !!u);
  const emails = new Map<string, string | null>();
  await Promise.all(
    usedIds.map(async (id) => emails.set(id, maskEmail((await deps.authUser(id))?.email))),
  );
  const granted = await grantedSources(
    deps.db,
    userId,
    raw.filter((i) => i.usedBy).map((i) => inviteSource(i.id, "inviter")),
  );
  const invites: InviteRow[] = raw.map((i) => ({
    id: i.id,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    usedBy: i.usedBy,
    usedAt: i.usedAt,
    note: i.note,
    revokedAt: i.revokedAt ?? null,
    status: i.usedBy
      ? "used"
      : i.revokedAt
        ? "revoked"
        : i.expiresAt !== null && now >= i.expiresAt
          ? "expired"
          : "open",
    ...(i.usedBy
      ? {
          usedByEmail: emails.get(i.usedBy) ?? null,
          bonus: granted.has(inviteSource(i.id, "inviter")) ? ("granted" as const) : ("pending" as const),
        }
      : {}),
  }));
  const blocked = abuseReason(auth);
  const oldEnough = ageDays(auth?.createdAt, now) >= INVITE_MIN_ACCOUNT_AGE_DAYS;
  const canInvite = !blocked && oldEnough;
  return {
    quota,
    invites,
    canInvite,
    blockedReason: blocked,
    unlocksAt:
      !blocked && !oldEnough && auth?.createdAt
        ? new Date(new Date(auth.createdAt).getTime() + INVITE_MIN_ACCOUNT_AGE_DAYS * DAY_MS).toISOString()
        : null,
    bonusCredits: INVITE_BONUS_CREDITS,
  };
}

export class InviteError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason: string,
  ) {
    super(message);
  }
}

export async function createInvite(userId: string, note = "", deps: CreditDeps = getCreditDeps()) {
  const auth = await deps.authUser(userId);
  const blocked = abuseReason(auth);
  if (blocked === "email not confirmed") {
    throw new InviteError("Confirm your email address before sending invites.", 403, "unconfirmed");
  }
  if (blocked) throw new InviteError("This account cannot send invites.", 403, "blocked");
  if (ageDays(auth?.createdAt, deps.now()) < INVITE_MIN_ACCOUNT_AGE_DAYS) {
    throw new InviteError(
      `Invites unlock once your account is ${INVITE_MIN_ACCOUNT_AGE_DAYS} days old.`,
      403,
      "too_new",
    );
  }
  try {
    return await deps.affiliates.createInvite(userId, String(note ?? "").slice(0, 200));
  } catch (err) {
    if (/no invites left/i.test(String((err as Error)?.message))) {
      throw new InviteError("You have no invites left.", 409, "no_invites_left");
    }
    throw err;
  }
}

export async function revokeInvite(userId: string, inviteId: string, deps: CreditDeps = getCreditDeps()) {
  const mine = (await deps.affiliates.invites(userId)).find((i) => i.id === inviteId);
  if (!mine) throw new InviteError("Invite not found.", 404, "not_found");
  if (mine.usedBy) throw new InviteError("That invite has already been used.", 409, "used");
  await deps.affiliates.revokeInvite(inviteId);
}

export const ACCEPT_MESSAGES: Record<string, string> = {
  invalid: "That invite code is not valid.",
  expired: "That invite has expired.",
  used: "That invite has already been used.",
  self: "You cannot use your own invite.",
  revoked: "That invite was withdrawn.",
  already_invited: "Your account has already joined on an invite.",
  not_new: `Invites are for new accounts (${INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS} days old or less).`,
  no_account: "Account not found.",
};

/**
 * Spend an invite on a (new) account and record who invited whom. The bonus is
 * NOT granted here unconditionally: settleInviteBonus() grants it once the
 * account qualifies. It runs right after, in the email-confirmation callback,
 * and whenever either side opens /dashboard/invites.
 */
export async function acceptInvite(
  userId: string,
  code: string,
  deps: CreditDeps = getCreditDeps(),
): Promise<
  | { ok: true; inviterId: string; inviteId: string; bonus: "granted" | "pending"; pendingReason?: string; message: string }
  | { ok: false; reason: string; message: string }
> {
  const fail = (reason: string) => ({ ok: false as const, reason, message: ACCEPT_MESSAGES[reason] ?? reason });
  const auth = await deps.authUser(userId);
  if (!auth) return fail("no_account");
  if (ageDays(auth.createdAt, deps.now()) > INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS) return fail("not_new");
  // No invitedBy() pre-check (a racy read): since @profullstack/affiliates 0.3 the
  // database lets an account redeem ONE invite, atomically (aff_claim_invite + unique
  // index aff_invites_one_per_user), so a second or concurrent accept comes back
  // `already_invited` and leaves that invite unused.
  const r = await deps.affiliates.redeemInvite(String(code ?? "").trim().slice(0, 64), userId);
  if (!r.ok) return fail(r.reason);

  const settled = await settleInviteBonus(userId, deps);
  const granted = settled.status === "granted" || settled.status === "already";
  return {
    ok: true,
    inviterId: r.inviterId,
    inviteId: r.inviteId,
    bonus: granted ? "granted" : "pending",
    ...(settled.status === "pending" ? { pendingReason: settled.reason } : {}),
    message: granted
      ? `Invite accepted. You both got ${INVITE_BONUS_CREDITS} credits.`
      : settled.status === "pending" && settled.reason === "email not confirmed"
        ? `Invite accepted. You both get ${INVITE_BONUS_CREDITS} credits once your email is confirmed.`
        : "Invite accepted. The bonus credits are on hold for review.",
  };
}

/**
 * Grant the invite bonus to both sides if the invited account qualifies now.
 * Idempotent: each side gets it once per invite (code_credit_grants primary
 * key). Safe to call often.
 */
export async function settleInviteBonus(
  inviteeId: string,
  deps: CreditDeps = getCreditDeps(),
): Promise<
  | { status: "none" }
  | { status: "pending"; reason: string }
  | { status: "granted" | "already"; inviteId: string; inviterId: string }
> {
  const inviterId = await deps.affiliates.invitedBy(inviteeId);
  if (!inviterId) return { status: "none" };
  const invite = (await deps.affiliates.invites(inviterId)).find((i) => i.usedBy === inviteeId);
  if (!invite) return { status: "none" };

  const [invitee, inviter] = await Promise.all([deps.authUser(inviteeId), deps.authUser(inviterId)]);
  const why = abuseReason(invitee);
  if (why) {
    if (why !== "email not confirmed") console.warn("[invites] bonus held:", { inviteeId, inviteId: invite.id, why });
    return { status: "pending", reason: why };
  }
  if (inviter && canonicalEmail(inviter.email) === canonicalEmail(invitee?.email)) {
    console.warn("[invites] bonus held: same inbox", { inviteeId, inviterId, inviteId: invite.id });
    return { status: "pending", reason: "same person" };
  }

  const gotInvitee = await grantCreditsOnce(
    deps.db,
    inviteeId,
    INVITE_BONUS_CREDITS,
    inviteSource(invite.id, "invitee"),
  );
  // An inviter banned since sending the invite does not get paid for it.
  let gotInviter = { applied: false };
  if (inviter && !inviter.banned) {
    gotInviter = await grantCreditsOnce(deps.db, inviterId, INVITE_BONUS_CREDITS, inviteSource(invite.id, "inviter"));
  }
  return {
    status: gotInvitee.applied || gotInviter.applied ? "granted" : "already",
    inviteId: invite.id,
    inviterId,
  };
}

/** Settle every used invite this user sent (cheap: at most the quota). */
export async function settleInvitesSentBy(inviterId: string, deps: CreditDeps = getCreditDeps()) {
  for (const inv of await deps.affiliates.invites(inviterId)) {
    if (!inv.usedBy) continue;
    try {
      await settleInviteBonus(inv.usedBy, deps);
    } catch (err) {
      console.error("[invites] settle failed", { inviteId: inv.id, err });
    }
  }
}

/**
 * After sign-in or email confirmation: accept a pending invite (cookie or
 * signup metadata) and settle any bonus. Never throws; a failure here must not
 * break sign-in.
 */
export async function onSignedIn(userId: string, inviteCode: string | null | undefined, deps?: CreditDeps) {
  try {
    const d = deps ?? getCreditDeps();
    if (inviteCode) {
      const r = await acceptInvite(userId, inviteCode, d);
      if (r.ok) return;
    }
    await settleInviteBonus(userId, d);
  } catch (err) {
    console.error("[invites] sign-in settle failed", err);
  }
}

/** The public origin for links, from the request host (never localhost). */
export function originFromHeaders(h: Headers, fallback: string): string {
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host)) {
    const proto = (h.get("x-forwarded-proto") ?? "https").split(",")[0].trim();
    return `${proto}://${host.split(",")[0].trim()}`;
  }
  return fallback.replace(/\/$/, "");
}

export function inviteUrl(origin: string, code: string) {
  return `${origin.replace(/\/$/, "")}/i/${encodeURIComponent(code)}`;
}
