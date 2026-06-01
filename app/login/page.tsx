import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./form";

export const metadata = {
  title: "Sign in",
  description: "Sign in to CrawlProof to manage audits, projects, and credits.",
  alternates: { canonical: "/login" },
  robots: { index: false, follow: true },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string; email?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect(sp.redirect ?? "/dashboard");

  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <Link href="/" className="text-sm text-[var(--color-muted)]">
        ← Back
      </Link>
      <h1 className="mt-6 text-3xl font-bold">Sign in to CrawlProof</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Save your audits, schedule re-runs, and export reports.
      </p>
      {sp.error && (
        <p className="mt-4 rounded-md border border-[rgba(248,113,113,0.4)] bg-[rgba(248,113,113,0.08)] p-3 text-sm text-[var(--color-fail)]">
          {sp.error}
        </p>
      )}
      <LoginForm redirectTo={sp.redirect} defaultEmail={sp.email} />
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        New here?{" "}
        <Link
          href={sp.redirect ? `/signup?redirect=${encodeURIComponent(sp.redirect)}` : "/signup"}
          className="underline"
        >
          Create an account
        </Link>
      </p>
    </main>
  );
}
