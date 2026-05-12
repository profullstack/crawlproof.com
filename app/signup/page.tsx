import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignupForm } from "./form";

export const metadata = { title: "Sign up" };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
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
      <h1 className="mt-6 text-3xl font-bold">Create your account</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Free tier: 10 audits/month, no card required.
      </p>
      <SignupForm redirectTo={sp.redirect} />
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        Have an account?{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
