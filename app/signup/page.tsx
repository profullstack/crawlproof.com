import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignupForm } from "./form";

export const metadata = {
  title: "Sign up",
  description:
    "Create a free CrawlProof account — get 20 free credits to run AEO audits across LLM engines.",
  alternates: { canonical: "/signup" },
  openGraph: {
    title: "Sign up for CrawlProof",
    description: "Create a free CrawlProof account — get 20 free credits to start.",
    url: "/signup",
  },
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; email?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect(sp.redirect ?? "/dashboard");

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
        Free tier: 10 audits/day per IP, no card required.
      </p>
      <SignupForm redirectTo={sp.redirect} defaultEmail={sp.email} />
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        Have an account?{" "}
        <Link href={loginHref} className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
