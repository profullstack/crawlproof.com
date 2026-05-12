import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./form";

export const metadata = { title: "Set a new password" };

export default async function ResetPasswordPage() {
  // Must arrive here with a session cookie set by /auth/callback after the
  // recovery email link. Without one, send them back to start the flow.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/forgot-password");
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-bold">Set a new password</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Choose a password for <strong>{user.email}</strong>. You&apos;ll be
        signed in afterwards.
      </p>
      <ResetPasswordForm />
    </main>
  );
}
