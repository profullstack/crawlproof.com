import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { INVITE_BONUS_CREDITS } from "@/lib/creditCodes";
import { InviteLanding } from "./invite-landing";

export const metadata: Metadata = {
  title: "You're invited",
  description: "Someone invited you to CrawlProof.",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = decodeURIComponent(raw).replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
  let signedIn = false;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = !!user;
  } catch {
    signedIn = false;
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12 text-center sm:px-6 sm:py-16">
      <Link href="/" className="text-sm text-[var(--color-muted)]">
        CrawlProof
      </Link>
      <h1 className="mt-6 text-3xl font-bold">You&apos;re invited</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Someone on CrawlProof handed you one of their three invites. Join with it and you both get{" "}
        {INVITE_BONUS_CREDITS} extra scan credits once your email is confirmed, on top of the usual signup credits.
      </p>
      <div className="card mt-6 space-y-4 p-6">
        <p className="text-sm">
          Invite code: <code className="font-mono">{code}</code>
        </p>
        <InviteLanding code={code} signedIn={signedIn} />
      </div>
    </main>
  );
}
