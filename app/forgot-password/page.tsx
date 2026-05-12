import Link from "next/link";
import { ForgotPasswordForm } from "./form";

export const metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <Link href="/login" className="text-sm text-[var(--color-muted)]">
        ← Back to sign in
      </Link>
      <h1 className="mt-6 text-3xl font-bold">Reset your password</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Enter your email and we&apos;ll send you a link to choose a new password.
      </p>
      <ForgotPasswordForm />
    </main>
  );
}
