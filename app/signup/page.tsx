import Link from "next/link";
import { TRIAL_CREDITS, TRIAL_DAYS } from "@/lib/trial";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { INVITE_BONUS_CREDITS, INVITE_COOKIE } from "@/lib/creditCodes";
import { createClient } from "@/lib/supabase/server";
import { SignupForm } from "./form";

export const metadata = {
  title: "Sign up",
  description:
    "Create a free CrawlProof account: every paid feature free for 30 days, no card required.",
  alternates: { canonical: "/signup" },
  openGraph: {
    title: "Sign up for CrawlProof",
    description: "Every paid CrawlProof feature free for 30 days. No card required.",
    url: "/signup",
  },
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; email?: string; invite?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect(sp.redirect ?? "/dashboard");
  const invite = (sp.invite ?? (await cookies()).get(INVITE_COOKIE)?.value ?? "")
    .replace(/[^A-Za-z0-9-]/g, "")
    .slice(0, 64);

  const loginHref = sp.redirect
    ? `/login?redirect=${encodeURIComponent(sp.redirect)}`
    : "/login";

  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <Link href="/" className="text-sm text-[var(--color-muted)]">
        ← Back
      </Link>
      <h1 className="mt-6 text-3xl font-bold">Create your account</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Every paid feature free for {TRIAL_DAYS} days: {TRIAL_CREDITS} trial credits for Buyer Intent, AI scans,
        lead generation and autoblog, plus Solo monitoring. No card required, nothing renews.{" "}
        <Link href="/products" className="underline">
          See what is included
        </Link>
      </p>
      {invite && (
        <div className="card mt-4 p-3 text-sm">
          You are joining on invite <code className="font-mono">{invite}</code>. You and the person who invited you
          each get {INVITE_BONUS_CREDITS} extra credits once your email is confirmed.
        </div>
      )}
      <SignupForm redirectTo={sp.redirect} defaultEmail={sp.email} inviteCode={invite || undefined} />
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        Have an account?{" "}
        <Link href={loginHref} className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
