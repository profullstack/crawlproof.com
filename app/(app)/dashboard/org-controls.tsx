"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createOrganization,
  moveProjectToOrganization,
} from "@/app/actions/orgs";

export type DashboardOrg = {
  id: string;
  name: string;
  role: "owner" | "member";
};

export function OrgDashboardControls({
  orgs,
  selectedOrgId,
}: {
  orgs: DashboardOrg[];
  selectedOrgId: string | null;
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
    </section>
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
