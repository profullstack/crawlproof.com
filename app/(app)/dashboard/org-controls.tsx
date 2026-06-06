"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createOrganization,
  deleteOrganizationOutreachConfig,
  moveProjectToOrganization,
  saveOrganizationOutreachConfig,
} from "@/app/actions/orgs";

export type DashboardOrg = {
  id: string;
  name: string;
  role: "owner" | "member";
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
}: {
  orgs: DashboardOrg[];
  selectedOrgId: string | null;
  senderConfigs: DashboardSenderConfig[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function selectOrg(orgId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (orgId) params.set("org", orgId);
    else params.delete("org");
    router.push(`/dashboard${params.size ? `?${params}` : ""}`);
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
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Organization</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Group projects and move them between owned orgs.
          </p>
        </div>
        <select
          value={selectedOrgId ?? ""}
          onChange={(event) => selectOrg(event.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
        >
          {orgs.length === 0 && <option value="">Default workspace</option>}
          {orgs.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name} ({org.role})
            </option>
          ))}
        </select>
      </div>

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
      {selectedOrgId && orgs.find((org) => org.id === selectedOrgId)?.role === "owner" && (
        <SenderConfigPanel
          organizationId={selectedOrgId}
          senderConfigs={senderConfigs}
        />
      )}
    </section>
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
                <Field name="smtpHost" label="SMTP host" placeholder="smtp.example.com" />
                <Field name="smtpPort" label="SMTP port" placeholder="587" />
                <Field name="smtpUser" label="SMTP user" />
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
