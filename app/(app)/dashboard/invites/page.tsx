import Link from "next/link";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import {
  INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS,
  INVITE_BONUS_CREDITS,
  inviteOverview,
  originFromHeaders,
  settleInviteBonus,
  settleInvitesSentBy,
} from "@/lib/creditCodes";
import { InvitesPanel } from "./invites-panel";

export const metadata = { title: "Invites" };
export const dynamic = "force-dynamic";

export default async function InvitesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user!.id;

  // Pay out any bonus that became due since the last visit (idempotent).
  await settleInvitesSentBy(userId).catch(() => null);
  await settleInviteBonus(userId).catch(() => null);
  const overview = await inviteOverview(userId);
  const origin = originFromHeaders(await headers(), env.siteUrl);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Invites</h1>
        <p className="mt-2 max-w-2xl text-[var(--color-muted)]">
          You have {overview.quota.total} invites, ever. Hand one to someone you want on CrawlProof. When their new
          account is confirmed, you each get {INVITE_BONUS_CREDITS} scan credits. Invites are for new accounts
          ({INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS} days old or less), work once and expire after 30 days.
        </p>
      </div>

      <InvitesPanel
        origin={origin}
        initial={{
          quota: overview.quota,
          invites: overview.invites,
          canInvite: overview.canInvite,
          blockedReason: overview.blockedReason,
          unlocksAt: overview.unlocksAt,
        }}
      />

      <div className="card p-5 text-sm">
        <h2 className="font-semibold">Want an open link instead?</h2>
        <p className="mt-1 text-[var(--color-muted)]">
          Invites are scarce on purpose. For an unlimited link that pays commission on purchases, use the{" "}
          <Link href="/dashboard/affiliate" className="underline">
            affiliate program
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
