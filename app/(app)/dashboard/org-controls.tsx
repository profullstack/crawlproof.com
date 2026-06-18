"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createOrganization,
  deleteOrganization,
  deleteOrganizationOutreachConfig,
  mergeOrganization,
  moveProjectToOrganization,
  renameOrganization,
  saveOrganizationOutreachConfig,
  setDefaultOrganization,
} from "@/app/actions/orgs";
import {
  inviteOrgMember,
  removeOrgMember,
  revokeOrgInvitation,
  setOrgMemberRole,
  type OrgInviteRole,
  type OrgPendingInvitation,
  type OrgTeamMember,
} from "@/app/actions/org-members";

export type DashboardOrg = {
  id: string;
  name: string;
  role: "owner" | "member" | "viewer" | "project_member";
};

export type DashboardOrgTeam = {
  isOwner: boolean;
  members: OrgTeamMember[];
  invitations: OrgPendingInvitation[];
};

export type DashboardSenderConfig = {
  id: string;
  label: string;
  channel: "email" | "sms" | "social";
  provider: "smtp" | "resend" | "twilio" | "telnyx" | "manual";
  enabled: boolean;
  is_default: boolean;
  from_email: string | null;
  from_phone: string | null;
  created_at: string;
};

export function OrgDashboardControls({
  orgs,
  selectedOrgId,
  senderConfigs,
  orgTeam,
}: {
  orgs: DashboardOrg[];
  selectedOrgId: string | null;
  senderConfigs: DashboardSenderConfig[];
  orgTeam: DashboardOrgTeam | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const selectedOrg = orgs.find((org) => org.id === selectedOrgId) ?? null;
  const isOwner = selectedOrg?.role === "owner";

  function selectOrg(orgId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (orgId) params.set("org", orgId);
    else params.delete("org");
    setMessage(null);
    startTransition(async () => {
      if (orgId) {
        const result = await setDefaultOrganization({ orgId });
        if (!result.ok) {
          setMessage(result.error);
          return;
        }
      }
      router.push(`/dashboard${params.size ? `?${params}` : ""}`);
      router.refresh();
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await createOrganization({ name });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setName("");
      setMessage("Organization created.");
      router.push(`/dashboard?org=${result.id}`);
      router.refresh();
    });
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">Organization</h2>
          <select
            value={selectedOrgId ?? ""}
            onChange={(event) => selectOrg(event.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          >
            {orgs.length === 0 && <option value="">Default workspace</option>}
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name} ({formatOrgRole(org.role)})
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="btn btn-secondary text-sm"
        >
          {open ? "Hide settings" : "Manage"}
        </button>
      </div>

      {!open ? null : (
      <div className="mt-4 space-y-3 border-t border-[var(--color-border)] pt-4">
      <p className="text-sm text-[var(--color-muted)]">
        Group projects and move them between owned orgs.
      </p>

      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="min-w-56 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          placeholder="New org name"
          maxLength={80}
        />
        <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
          {pending ? "Creating..." : "Create org"}
        </button>
      </form>
      {message && (
        <p
          className={`text-sm ${
            message === "Organization created." ? "text-green-700" : "text-red-600"
          }`}
        >
          {message}
        </p>
      )}
      {selectedOrgId && isOwner && (
        <RenameOrgForm
          key={selectedOrgId}
          orgId={selectedOrgId}
          currentName={selectedOrg?.name ?? ""}
        />
      )}

      {selectedOrgId && orgTeam && (
        <OrgMembersPanel
          key={selectedOrgId}
          orgId={selectedOrgId}
          isOwner={orgTeam.isOwner}
          members={orgTeam.members}
          invitations={orgTeam.invitations}
        />
      )}

      {selectedOrgId && isOwner && (
        <>
          <SenderConfigPanel
            organizationId={selectedOrgId}
            senderConfigs={senderConfigs}
          />
          <DangerZonePanel
            orgId={selectedOrgId}
            orgs={orgs}
          />
        </>
      )}
      </div>
      )}
    </section>
  );
}

function formatOrgRole(role: DashboardOrg["role"]) {
  if (role === "project_member") return "project access";
  if (role === "viewer") return "read-only";
  return role;
}

function RenameOrgForm({
  orgId,
  currentName,
}: {
  orgId: string;
  currentName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await renameOrganization({ orgId, name });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setMessage("Saved.");
      router.refresh();
    });
  }

  const dirty = name.trim() !== currentName.trim();

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <label className="text-sm font-medium text-[var(--color-muted)]">Rename</label>
      <input
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setMessage(null);
        }}
        className="min-w-56 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
        placeholder="Organization name"
        maxLength={80}
      />
      <button
        type="submit"
        className="btn btn-secondary text-sm"
        disabled={pending || !dirty || !name.trim()}
      >
        {pending ? "Saving..." : "Save"}
      </button>
      {message && (
        <span className={`text-sm ${message === "Saved." ? "text-green-700" : "text-red-600"}`}>
          {message}
        </span>
      )}
    </form>
  );
}

function OrgMembersPanel({
  orgId,
  isOwner,
  members,
  invitations,
}: {
  orgId: string;
  isOwner: boolean;
  members: OrgTeamMember[];
  invitations: OrgPendingInvitation[];
}) {
  return (
    <details className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Team members
        <span className="ml-1.5 text-xs text-[var(--color-muted)]">{members.length}</span>
      </summary>
      <div className="mt-3 space-y-4">
        {isOwner && <OrgInviteForm orgId={orgId} />}

        <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
          {members.map((m) => (
            <OrgMemberRow key={m.id} orgId={orgId} member={m} isOwner={isOwner} />
          ))}
        </ul>

        {isOwner && invitations.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-[var(--color-muted)]">
              Pending invitations
            </p>
            <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
              {invitations.map((inv) => (
                <OrgInvitationRow key={inv.id} orgId={orgId} invitation={inv} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function OrgInviteForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgInviteRole>("member");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await inviteOrgMember(orgId, email, role);
      if (result.ok) {
        setEmail("");
        setMessage({ ok: true, text: "Invitation sent." });
        router.refresh();
      } else {
        setMessage({ ok: false, text: result.error ?? "Something went wrong." });
      }
    });
  }

  return (
    <div>
      <p className="text-xs text-[var(--color-muted)]">
        Members can see and edit every project in this org. Read-only members
        can view everything but can&apos;t make changes.
      </p>
      <form onSubmit={submit} className="mt-2 flex flex-wrap gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="off"
          placeholder="teammate@company.com"
          className="min-w-56 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm"
        />
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as OrgInviteRole)}
          aria-label="Access level"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-2 text-sm"
        >
          <option value="member">Member (can edit)</option>
          <option value="viewer">Read-only (view only)</option>
        </select>
        <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
          {pending ? "Sending…" : "Send invite"}
        </button>
      </form>
      {message && (
        <p className={`mt-2 text-sm ${message.ok ? "text-green-700" : "text-red-600"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

function OrgMemberRow({
  orgId,
  member,
  isOwner,
}: {
  orgId: string;
  member: OrgTeamMember;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const label =
    member.profile?.display_name || member.profile?.email || "Unknown user";
  const sub = member.profile?.display_name
    ? member.profile.email
    : new Date(member.created_at).toLocaleDateString();
  const isViewer = member.role === "viewer";
  // Owners can manage full members and read-only viewers (not other owners
  // or project-access markers).
  const manageable = member.role === "member" || member.role === "viewer";

  function remove() {
    startTransition(async () => {
      await removeOrgMember(orgId, member.user_id);
      router.refresh();
    });
  }

  function toggleRole() {
    startTransition(async () => {
      await setOrgMemberRole(orgId, member.user_id, isViewer ? "member" : "viewer");
      router.refresh();
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {label}
          {member.role === "owner" && (
            <span className="ml-2 badge badge-pass align-middle text-[11px]">owner</span>
          )}
          {isViewer && (
            <span className="ml-2 badge align-middle text-[11px]">read-only</span>
          )}
          {member.role === "project_member" && (
            <span className="ml-2 badge align-middle text-[11px]">project access</span>
          )}
        </p>
        {sub && <p className="truncate text-xs text-[var(--color-muted)]">{sub}</p>}
      </div>
      {isOwner && manageable && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleRole}
            disabled={pending}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
          >
            {pending ? "Saving…" : isViewer ? "Make editor" : "Make read-only"}
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {pending ? "Removing…" : "Remove"}
          </button>
        </div>
      )}
    </li>
  );
}

function OrgInvitationRow({
  orgId,
  invitation,
}: {
  orgId: string;
  invitation: OrgPendingInvitation;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const expired = new Date(invitation.expires_at) < new Date();

  function revoke() {
    startTransition(async () => {
      await revokeOrgInvitation(orgId, invitation.id);
      router.refresh();
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {invitation.email}
          {invitation.role === "viewer" && (
            <span className="ml-2 badge align-middle text-[11px]">read-only</span>
          )}
        </p>
        <p className="text-xs text-[var(--color-muted)]">
          {expired
            ? "Expired"
            : `Expires ${new Date(invitation.expires_at).toLocaleDateString()}`}
        </p>
      </div>
      <button
        type="button"
        onClick={revoke}
        disabled={pending}
        className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
    </li>
  );
}

type SenderChannel = "email" | "sms" | "social";
type SenderProvider = "smtp" | "resend" | "twilio" | "telnyx" | "manual";

function SenderConfigPanel({
  organizationId,
  senderConfigs,
}: {
  organizationId: string;
  senderConfigs: DashboardSenderConfig[];
}) {
  return (
    <details className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Outreach sender config
      </summary>
      <div className="mt-3 space-y-3">
        <SenderConfigList
          organizationId={organizationId}
          senderConfigs={senderConfigs}
        />
        <SenderConfigForm organizationId={organizationId} />
      </div>
    </details>
  );
}

function SenderConfigList({
  organizationId,
  senderConfigs,
}: {
  organizationId: string;
  senderConfigs: DashboardSenderConfig[];
}) {
  if (senderConfigs.length === 0) {
    return (
      <p className="text-xs text-[var(--color-muted)]">
        No org sender configs yet.
      </p>
    );
  }

  return (
    <ul className="grid gap-2 md:grid-cols-2">
      {senderConfigs.map((config) => (
        <li
          key={config.id}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{config.label}</div>
              <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-[var(--color-muted)]">
                <span className="badge">{config.channel}</span>
                <span className="badge">{config.provider}</span>
                {config.is_default && <span className="badge badge-pass">default</span>}
                {!config.enabled && <span className="badge badge-unknown">off</span>}
              </div>
              {(config.from_email || config.from_phone) && (
                <div className="mt-2 truncate text-xs text-[var(--color-muted)]">
                  {config.from_email ?? config.from_phone}
                </div>
              )}
            </div>
            <DeleteSenderConfigButton
              organizationId={organizationId}
              configId={config.id}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function DeleteSenderConfigButton({
  organizationId,
  configId,
}: {
  organizationId: string;
  configId: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function remove() {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteOrganizationOutreachConfig({
        organizationId,
        configId,
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        onClick={remove}
        disabled={pending}
        className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
      >
        {pending ? "Deleting..." : "Delete"}
      </button>
      {message && <p className="mt-1 max-w-32 text-xs text-red-600">{message}</p>}
    </div>
  );
}

function SenderConfigForm({ organizationId }: { organizationId: string }) {
  const [channel, setChannel] = useState<SenderChannel>("email");
  const [provider, setProvider] = useState<SenderProvider>("smtp");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setMessage(null);
    startTransition(async () => {
      const result = await saveOrganizationOutreachConfig({
        organizationId,
        label: String(form.get("label") ?? ""),
        channel,
        provider,
        fromEmail: String(form.get("fromEmail") ?? ""),
        fromPhone: String(form.get("fromPhone") ?? ""),
        replyTo: String(form.get("replyTo") ?? ""),
        smtpHost: String(form.get("smtpHost") ?? ""),
        smtpPort: String(form.get("smtpPort") ?? ""),
        smtpSecure: form.get("smtpSecure") === "on",
        smtpUser: String(form.get("smtpUser") ?? ""),
        smtpPass: String(form.get("smtpPass") ?? ""),
        apiKey: String(form.get("apiKey") ?? ""),
        accountSid: String(form.get("accountSid") ?? ""),
        authToken: String(form.get("authToken") ?? ""),
      });
      setMessage(result.ok ? "Sender saved." : result.error);
      if (result.ok) formEl.reset();
    });
  }

  function setNextChannel(next: SenderChannel) {
    setChannel(next);
    setProvider(next === "email" ? "smtp" : next === "sms" ? "twilio" : "manual");
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 border-t border-[var(--color-border)] pt-3 text-sm md:grid-cols-2"
    >
        <label>
          <span className="text-xs font-medium">Channel</span>
          <select
            value={channel}
            onChange={(event) => setNextChannel(event.target.value as SenderChannel)}
            className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5"
          >
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="social">Social</option>
          </select>
        </label>
        <label>
          <span className="text-xs font-medium">Provider</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as typeof provider)}
            className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5"
          >
            {channel === "email" ? (
              <>
                <option value="smtp">SMTP</option>
                <option value="resend">Resend</option>
              </>
            ) : channel === "sms" ? (
              <>
                <option value="twilio">Twilio</option>
                <option value="telnyx">Telnyx</option>
              </>
            ) : (
              <option value="manual">Manual</option>
            )}
          </select>
        </label>
        <Field
          name="label"
          label="Label"
          placeholder={channel === "social" ? "Prospects social" : "Prospects email"}
          required
        />
        {channel === "email" ? (
          <>
            <Field name="fromEmail" label="From email" placeholder="CrawlProof <hello@crawlproof.com>" />
            <Field name="replyTo" label="Reply-to" placeholder="hello@crawlproof.com" />
            {provider === "smtp" && (
              <>
                <Field name="smtpHost" label="SMTP host" placeholder="smtp.forwardemail.net" />
                <Field name="smtpPort" label="SMTP port" placeholder="465" />
                <Field name="smtpUser" label="SMTP user" placeholder="hello@example.com" />
                <Field name="smtpPass" label="SMTP password" type="password" />
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="smtpSecure" />
                  Use SMTP TLS wrapper
                </label>
              </>
            )}
            {provider === "resend" && (
              <Field name="apiKey" label="Resend API key" type="password" />
            )}
          </>
        ) : channel === "sms" ? (
          <>
            <Field name="fromPhone" label="From phone" placeholder="+15551234567" />
            {provider === "twilio" ? (
              <>
                <Field name="accountSid" label="Twilio account SID" />
                <Field name="authToken" label="Twilio auth token" type="password" />
              </>
            ) : (
              <Field name="apiKey" label="Telnyx API key" type="password" />
            )}
          </>
        ) : null}
        <div className="flex items-center gap-3 md:col-span-2">
          <button type="submit" className="btn btn-secondary text-sm" disabled={pending}>
            {pending ? "Saving..." : "Save sender"}
          </button>
          {message && (
            <p className={`text-sm ${message === "Sender saved." ? "text-green-700" : "text-red-600"}`}>
              {message}
            </p>
          )}
        </div>
    </form>
  );
}

function Field({
  name,
  label,
  placeholder,
  type = "text",
  required = false,
}: {
  name: string;
  label: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label>
      <span className="text-xs font-medium">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5"
      />
    </label>
  );
}

function DangerZonePanel({
  orgId,
  orgs,
}: {
  orgId: string;
  orgs: DashboardOrg[];
}) {
  const router = useRouter();
  const ownedOrgs = orgs.filter((org) => org.role === "owner" && org.id !== orgId);

  const [mergeTarget, setMergeTarget] = useState(ownedOrgs[0]?.id ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setMessage(null);
    startTransition(async () => {
      const result = await deleteOrganization({ orgId });
      if (!result.ok) { setMessage(result.error); setConfirmDelete(false); return; }
      router.push("/dashboard");
      router.refresh();
    });
  }

  function handleMerge() {
    if (!mergeTarget) return;
    if (!confirmMerge) { setConfirmMerge(true); return; }
    setMessage(null);
    startTransition(async () => {
      const result = await mergeOrganization({ sourceOrgId: orgId, targetOrgId: mergeTarget });
      if (!result.ok) { setMessage(result.error); setConfirmMerge(false); return; }
      router.push(`/dashboard?org=${mergeTarget}`);
      router.refresh();
    });
  }

  return (
    <details className="rounded-md border border-red-200 bg-[var(--color-bg)] p-3">
      <summary className="cursor-pointer text-sm font-medium text-red-700">
        Danger zone
      </summary>
      <div className="mt-3 space-y-4">
        {ownedOrgs.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--color-muted)]">
              Move all projects and audits from this org into another org, then delete this org.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={mergeTarget}
                onChange={(e) => { setMergeTarget(e.target.value); setConfirmMerge(false); }}
                disabled={pending}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
              >
                {ownedOrgs.map((org) => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleMerge}
                disabled={pending || !mergeTarget}
                className="rounded border border-red-400 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {pending ? "Merging..." : confirmMerge ? "Confirm merge & delete" : "Merge into org"}
              </button>
              {confirmMerge && !pending && (
                <button
                  type="button"
                  onClick={() => setConfirmMerge(false)}
                  className="text-xs text-[var(--color-muted)] underline"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
          <p className="text-xs text-[var(--color-muted)]">
            Delete this org permanently. Only works if the org has no projects.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleDelete}
              disabled={pending}
              className="rounded border border-red-400 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {pending ? "Deleting..." : confirmDelete ? "Confirm delete org" : "Delete org"}
            </button>
            {confirmDelete && !pending && (
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="text-xs text-[var(--color-muted)] underline"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {message && <p className="text-sm text-red-600">{message}</p>}
      </div>
    </details>
  );
}

export function ProjectOrgMoveControl({
  projectId,
  currentOrgId,
  orgs,
}: {
  projectId: string;
  currentOrgId: string | null;
  orgs: DashboardOrg[];
}) {
  const router = useRouter();
  const ownedOrgs = orgs.filter((org) => org.role === "owner");
  const [value, setValue] = useState(currentOrgId ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (ownedOrgs.length <= 1) return null;

  function move(nextOrgId: string) {
    setValue(nextOrgId);
    setMessage(null);
    startTransition(async () => {
      const result = await moveProjectToOrganization({
        projectId,
        organizationId: nextOrgId,
      });
      if (!result.ok) {
        setMessage(result.error);
        setValue(currentOrgId ?? "");
        return;
      }
      setMessage("Moved.");
      router.refresh();
    });
  }

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-3">
      <label className="block text-xs text-[var(--color-muted)]">
        Move to org
        <select
          value={value}
          onChange={(event) => move(event.target.value)}
          disabled={pending}
          className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs text-[var(--color-fg)]"
        >
          {ownedOrgs.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
      </label>
      {message && (
        <p
          className={`mt-1 text-xs ${
            message === "Moved." ? "text-green-700" : "text-red-600"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
