import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export const metadata = { robots: { index: false } };

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const svc = serviceClient();

  const { data: inv } = await svc
    .from("project_invitations")
    .select("id, project_id, email, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle();

  if (!inv) {
    return (
      <InviteShell>
        <h1 className="text-2xl font-bold">Invalid invitation</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          This link is invalid or has already been revoked.
        </p>
      </InviteShell>
    );
  }

  if (inv.accepted_at) {
    return (
      <InviteShell>
        <h1 className="text-2xl font-bold">Already accepted</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          This invitation has already been used.
        </p>
        <Link
          href={`/projects/${inv.project_id}`}
          className="btn mt-6 inline-block"
        >
          Go to project
        </Link>
      </InviteShell>
    );
  }

  if (new Date(inv.expires_at) < new Date()) {
    return (
      <InviteShell>
        <h1 className="text-2xl font-bold">Invitation expired</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          This invitation link has expired. Ask the project owner to send a new one.
        </p>
      </InviteShell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?redirect=/invite/${token}`);
  }

  const { data: userProfile } = await svc
    .from("profiles")
    .select("email")
    .eq("id", user.id)
    .maybeSingle();

  if (userProfile?.email?.toLowerCase() !== inv.email.toLowerCase()) {
    return (
      <InviteShell>
        <h1 className="text-2xl font-bold">Wrong account</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          This invitation was sent to{" "}
          <strong className="text-[var(--color-fg)]">{inv.email}</strong>.
          Please sign in with that email address to accept.
        </p>
        <Link href="/login" className="btn mt-6 inline-block">
          Sign in with correct account
        </Link>
      </InviteShell>
    );
  }

  // Check if already a member
  const { data: existing } = await svc
    .from("project_members")
    .select("id")
    .eq("project_id", inv.project_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!existing) {
    // Fetch invited_by to populate the foreign key
    const { data: invitationFull } = await svc
      .from("project_invitations")
      .select("invited_by")
      .eq("id", inv.id)
      .single();

    await svc.from("project_members").insert({
      project_id: inv.project_id,
      user_id: user.id,
      invited_by: invitationFull?.invited_by ?? user.id,
    });
  }

  await svc
    .from("project_invitations")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", inv.id);

  redirect(`/projects/${inv.project_id}`);
}

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-md px-4 py-16 sm:px-6">
      <Link href="/" className="text-sm text-[var(--color-muted)]">
        ← CrawlProof
      </Link>
      <div className="mt-8">{children}</div>
    </main>
  );
}
