"use client";

import { useState, useTransition } from "react";
import {
  inviteProjectMember,
  revokeProjectInvitation,
  removeProjectMember,
  setProjectMemberRole,
  type TeamMember,
  type PendingInvitation,
  type ProjectMemberRole,
} from "@/app/actions/project-members";

function RoleBadge({ role }: { role: ProjectMemberRole }) {
  const isViewer = role === "viewer";
  return (
    <span
      className={`badge ${isViewer ? "" : "badge-pass"} text-xs`}
      title={
        isViewer
          ? "Read-only — can view stats and project data but cannot make changes"
          : "Full team member — can view and edit project data"
      }
    >
      {isViewer ? "Read-only" : "Member"}
    </span>
  );
}

export function MembersClient({
  projectId,
  isOwner,
  members,
  invitations,
}: {
  projectId: string;
  isOwner: boolean;
  members: TeamMember[];
  invitations: PendingInvitation[];
}) {
  return (
    <div className="space-y-6">
      {isOwner && <InviteForm projectId={projectId} />}

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Team members</h2>
        {members.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            No team members yet. Invite someone to get started.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
            {members.map((m) => (
              <MemberRow
                key={m.id}
                projectId={projectId}
                member={m}
                isOwner={isOwner}
              />
            ))}
          </ul>
        )}
      </section>

      {isOwner && invitations.length > 0 && (
        <section className="card p-4">
          <h2 className="text-lg font-semibold">Pending invitations</h2>
          <ul className="mt-3 divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
            {invitations.map((inv) => (
              <InvitationRow
                key={inv.id}
                projectId={projectId}
                invitation={inv}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function InviteForm({ projectId }: { projectId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectMemberRole>("member");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    start(async () => {
      const res = await inviteProjectMember(projectId, email, role);
      if (res.ok) {
        setEmail("");
        setMessage({ ok: true, text: "Invitation sent." });
      } else {
        setMessage({ ok: false, text: res.error ?? "Something went wrong." });
      }
    });
  }

  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">Invite a team member</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        They'll get an email with a link to join this project. Invitees sign up
        for free — no payment required.
      </p>
      <form onSubmit={onSubmit} className="mt-3 flex flex-wrap gap-2">
        <input
          type="email"
          className="input min-w-0 flex-1"
          placeholder="teammate@company.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
        />
        <select
          className="input w-auto"
          value={role}
          onChange={(e) => setRole(e.target.value as ProjectMemberRole)}
          aria-label="Access level"
        >
          <option value="member">Member (can edit)</option>
          <option value="viewer">Read-only (view stats)</option>
        </select>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Sending…" : "Send invite"}
        </button>
      </form>
      <p className="mt-2 text-xs text-[var(--color-muted)]">
        Read-only members can view stats and project data but can't change any
        settings.
      </p>
      {message && (
        <p
          className={`mt-2 text-sm ${
            message.ok ? "text-[var(--color-pass)]" : "text-[var(--color-fail)]"
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

function MemberRow({
  projectId,
  member,
  isOwner,
}: {
  projectId: string;
  member: TeamMember;
  isOwner: boolean;
}) {
  const [pending, start] = useTransition();
  const label =
    member.profile?.display_name || member.profile?.email || "Unknown user";
  const sub = member.profile?.display_name
    ? member.profile.email
    : new Date(member.created_at).toLocaleDateString();
  const isViewer = member.role === "viewer";

  function onRemove() {
    start(async () => {
      await removeProjectMember(projectId, member.user_id);
    });
  }

  function onToggleRole() {
    start(async () => {
      await setProjectMemberRole(
        projectId,
        member.user_id,
        isViewer ? "member" : "viewer",
      );
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{label}</p>
          <RoleBadge role={member.role} />
        </div>
        {sub && (
          <p className="text-xs text-[var(--color-muted)]">{sub}</p>
        )}
      </div>
      {isOwner && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={pending}
            onClick={onToggleRole}
          >
            {pending
              ? "Saving…"
              : isViewer
                ? "Make editor"
                : "Make read-only"}
          </button>
          <button
            type="button"
            className="btn-ghost text-xs text-[var(--color-fail)]"
            disabled={pending}
            onClick={onRemove}
          >
            {pending ? "Removing…" : "Remove"}
          </button>
        </div>
      )}
    </li>
  );
}

function InvitationRow({
  projectId,
  invitation,
}: {
  projectId: string;
  invitation: PendingInvitation;
}) {
  const [pending, start] = useTransition();
  const expired = new Date(invitation.expires_at) < new Date();

  function onRevoke() {
    start(async () => {
      await revokeProjectInvitation(projectId, invitation.id);
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{invitation.email}</p>
          <RoleBadge role={invitation.role} />
        </div>
        <p className="text-xs text-[var(--color-muted)]">
          {expired
            ? "Expired"
            : `Expires ${new Date(invitation.expires_at).toLocaleDateString()}`}
        </p>
      </div>
      <button
        type="button"
        className="btn-ghost text-xs text-[var(--color-muted)]"
        disabled={pending}
        onClick={onRevoke}
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
    </li>
  );
}
