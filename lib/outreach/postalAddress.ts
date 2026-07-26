// Which postal address goes in the CAN-SPAM footer.
//
// Resolved most-specific-first: the project's own address, then the org's,
// then the sender's personal default, then the legacy env var. An agency
// sending on behalf of three clients needs three different footers, which a
// single env var could never express.
//
// The pure part is separated from the lookup so the precedence — the bit
// that decides what a real recipient sees in a legally-required footer — is
// testable without a database.

import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";

export type AddressSource = "project" | "organization" | "account" | "env" | "none";

export type ResolvedAddress = {
  address: string | null;
  source: AddressSource;
};

export type AddressLevels = {
  project?: string | null;
  organization?: string | null;
  account?: string | null;
  env?: string | null;
};

/** Most specific wins. Whitespace-only is treated as unset, not as an address. */
export function pickPostalAddress(levels: AddressLevels): ResolvedAddress {
  const ordered: Array<[AddressSource, string | null | undefined]> = [
    ["project", levels.project],
    ["organization", levels.organization],
    ["account", levels.account],
    ["env", levels.env],
  ];
  for (const [source, value] of ordered) {
    const trimmed = value?.trim();
    if (trimmed) return { address: trimmed, source };
  }
  return { address: null, source: "none" };
}

export function describeAddressSource(source: AddressSource): string {
  switch (source) {
    case "project":
      return "this project";
    case "organization":
      return "your organization";
    case "account":
      return "your account";
    case "env":
      return "the OUTREACH_POSTAL_ADDRESS environment variable";
    case "none":
      return "nowhere — no address is set";
  }
}

/**
 * Look up every level for a project and pick one. Called on the send path,
 * so it must never throw: a missing row is a missing address, not an error.
 */
export async function resolvePostalAddress(input: {
  projectId: string | null;
  ownerId: string;
}): Promise<ResolvedAddress> {
  const sb = serviceClient();

  let projectAddress: string | null = null;
  let orgAddress: string | null = null;

  if (input.projectId) {
    const { data: project } = await sb
      .from("projects")
      .select("outreach_postal_address, organization_id")
      .eq("id", input.projectId)
      .maybeSingle();
    projectAddress = (project?.outreach_postal_address as string | null) ?? null;

    const orgId = (project?.organization_id as string | null) ?? null;
    if (orgId) {
      const { data: org } = await sb
        .from("organizations")
        .select("outreach_postal_address")
        .eq("id", orgId)
        .maybeSingle();
      orgAddress = (org?.outreach_postal_address as string | null) ?? null;
    }
  }

  const { data: profile } = await sb
    .from("profiles")
    .select("outreach_postal_address")
    .eq("id", input.ownerId)
    .maybeSingle();

  return pickPostalAddress({
    project: projectAddress,
    organization: orgAddress,
    account: (profile?.outreach_postal_address as string | null) ?? null,
    env: env.outreachPostalAddress,
  });
}

/**
 * What the Leads page shows: the effective address plus each level on its
 * own, so the "import from account" button knows whether it has anything to
 * import and the user can see which level is actually winning.
 */
export type AddressSettings = ResolvedAddress & {
  levels: { project: string | null; organization: string | null; account: string | null };
  hasOrg: boolean;
};

export async function loadAddressSettings(input: {
  projectId: string;
  ownerId: string;
}): Promise<AddressSettings> {
  const sb = serviceClient();
  const { data: project } = await sb
    .from("projects")
    .select("outreach_postal_address, organization_id")
    .eq("id", input.projectId)
    .maybeSingle();

  const orgId = (project?.organization_id as string | null) ?? null;
  const [{ data: org }, { data: profile }] = await Promise.all([
    orgId
      ? sb.from("organizations").select("outreach_postal_address").eq("id", orgId).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("profiles").select("outreach_postal_address").eq("id", input.ownerId).maybeSingle(),
  ]);

  const levels = {
    project: (project?.outreach_postal_address as string | null) ?? null,
    organization: (org?.outreach_postal_address as string | null) ?? null,
    account: (profile?.outreach_postal_address as string | null) ?? null,
  };

  return {
    ...pickPostalAddress({ ...levels, env: env.outreachPostalAddress }),
    levels,
    hasOrg: Boolean(orgId),
  };
}
