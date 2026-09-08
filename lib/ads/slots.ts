// Publisher slots created from outside the dashboard.
//
// A slot is where ads render on a site the caller owns. Creating one from the
// CLI or the API means naming a site — "nichedb.dev" — and getting back an id
// and the two tags to paste: the ad unit and the stats tracker. The site's
// project is found by hostname, or created with the tracker on, because a
// blog that carries ads should be counting its readers too.
//
// Idempotent on the site: a second call for a site that already has a slot
// returns that slot. Every publisher unit on a page can share one slot id.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isAllowedTargetUrl } from "@/lib/rateLimit";

export type SlotPlacement = "inline" | "sidebar" | "footer" | "sticky";
export type SlotStatus = "active" | "inactive";

export type SlotRequest = {
  /** The site, as a hostname or URL. */
  site: string;
  placement?: SlotPlacement;
  formats?: string[];
  /** The format the pasted unit renders. */
  format?: string;
  status?: SlotStatus;
  /** Turn the site's stats tracker on (default true). */
  enableTracking?: boolean;
};

export type SlotSummary = {
  id: string;
  status: string;
  placement: string;
  formats: string[];
  project_id: string;
  site: string;
  created_at?: string;
  /** True when the site already had a slot and it was returned instead. */
  existing?: boolean;
  /** The ad unit plus the tracker, ready to paste before </body>. */
  embed: string;
  tracker: string;
  dashboard_url: string;
};

export type SlotResult = { ok: true; slot: SlotSummary } | { ok: false; status: number; error: string };

const PLACEMENTS = new Set<SlotPlacement>(["inline", "sidebar", "footer", "sticky"]);
/** What a unit written into a blog page renders by default: the text strip. */
export const DEFAULT_UNIT_FORMAT = "text_link";

export function hostOf(input: string): string | null {
  const check = isAllowedTargetUrl(input);
  if (!check.ok) return null;
  try {
    return new URL(check.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Pure: what a caller sent, normalised. */
export function parseSlotRequest(body: Record<string, unknown>): { ok: true; request: SlotRequest; host: string } | { ok: false; error: string } {
  const site = typeof body.site === "string" ? body.site : typeof body.url === "string" ? body.url : "";
  const host = hostOf(site);
  if (!host) return { ok: false, error: "site must be a hostname or URL you own, like nichedb.dev." };

  const request: SlotRequest = { site: host };
  if (body.placement !== undefined) {
    if (!PLACEMENTS.has(body.placement as SlotPlacement)) return { ok: false, error: "placement must be inline, sidebar, footer or sticky." };
    request.placement = body.placement as SlotPlacement;
  }
  if (body.formats !== undefined) {
    const raw = Array.isArray(body.formats) ? body.formats : String(body.formats).split(",");
    const formats = raw.map((f) => String(f).trim()).filter((f) => /^[a-z0-9_]+$/.test(f));
    if (!formats.length) return { ok: false, error: "formats must name at least one ad format." };
    request.formats = formats;
  }
  if (body.format !== undefined) {
    const format = String(body.format).trim();
    if (!/^[a-z0-9_]+$/.test(format)) return { ok: false, error: "format must be an ad format id, like text_link." };
    request.format = format;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "inactive") return { ok: false, error: 'status must be "active" or "inactive".' };
    request.status = body.status;
  }
  if (body.enable_tracking !== undefined || body.enableTracking !== undefined) {
    request.enableTracking = (body.enable_tracking ?? body.enableTracking) !== false;
  }
  return { ok: true, request, host };
}

/** The tags a publisher pastes: the unit, then the tracker and the renderer. */
export function embedFor(siteUrl: string, slotId: string, projectId: string, format: string): { embed: string; tracker: string } {
  const origin = siteUrl.replace(/\/$/, "");
  const tracker = `<script data-site="${projectId}" src="${origin}/stats.js" async></script>`;
  const unit = `<aside data-cp-ad data-slot="${slotId}" data-format="${format}"></aside>`;
  const renderer = `<script src="${origin}/ad.js" async></script>`;
  return { embed: `${unit}\n\n${tracker}\n${renderer}`, tracker };
}

function sameHost(projectUrl: string | null | undefined, host: string): boolean {
  if (!projectUrl) return false;
  const candidate = hostOf(projectUrl);
  return candidate === host;
}

export async function createSlotForSite(input: {
  sb: SupabaseClient;
  userId: string;
  request: SlotRequest;
  siteUrl: string;
}): Promise<SlotResult> {
  const { sb, userId, request } = input;
  const host = request.site;
  const enableTracking = request.enableTracking !== false;
  const unitFormat = request.format ?? DEFAULT_UNIT_FORMAT;

  // The site's project: the one whose URL is this host, else a new one.
  const { data: projects, error: projectsError } = await sb
    .from("projects")
    .select("id, name, url, organization_id, tracker_enabled")
    .eq("owner_id", userId)
    .order("created_at", { ascending: true });
  if (projectsError) return { ok: false, status: 500, error: projectsError.message };
  type ProjectRow = { id: string; name: string; url: string; organization_id?: string | null; tracker_enabled?: boolean };
  let project = (projects ?? []).find((p) => sameHost((p as { url?: string }).url, host)) as ProjectRow | undefined;

  if (!project) {
    const { data: created, error } = await sb
      .from("projects")
      .insert({ owner_id: userId, name: host, url: `https://${host}`, tracker_enabled: enableTracking })
      .select("id, name, url, organization_id, tracker_enabled")
      .single();
    if (error || !created) return { ok: false, status: 500, error: error?.message ?? "Failed to create the site." };
    project = created as ProjectRow;
  } else if (enableTracking && project.tracker_enabled === false) {
    await sb.from("projects").update({ tracker_enabled: true }).eq("id", project.id).eq("owner_id", userId);
  }
  if (!project) return { ok: false, status: 500, error: "Failed to resolve the site." };

  // A project with no organization is invisible in the dashboard: both the
  // portfolio and the analytics page scope their query with
  // `.eq("organization_id", selectedOrg.id).or(accessFilter)`, and PostgREST
  // ANDs those, so an org-less row is dropped for its own owner the moment an
  // org is picked. It still collects traffic perfectly — it just cannot be
  // read — and the next "add site" mints a duplicate that shadows it in every
  // lookup by hostname. Attach one on the way in, for the project we just
  // created and for any older org-less row we found.
  //
  // Imported dynamically: `@/lib/orgs` pulls in `server-only`, which vitest
  // cannot load, and this module's pure helpers are unit-tested.
  if (!project.organization_id) {
    try {
      const { ensureProjectOrg } = await import("@/lib/orgs");
      const orgId = await ensureProjectOrg({ projectId: project.id, userId });
      if (orgId) project.organization_id = orgId;
    } catch {
      // An install without the org schema still gets a working slot.
    }
  }

  const select = "id, status, placement, formats, project_id, created_at";
  const { data: existing } = await sb
    .from("ad_slots")
    .select(select)
    .eq("project_id", project.id)
    .eq("owner_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  type SlotRow = { id: string; status: string; placement: string; formats: string[]; project_id: string; created_at?: string };
  let slot = existing as SlotRow | null;
  let wasExisting = false;
  if (slot) {
    wasExisting = true;
    const wanted = request.status ?? "active";
    if (wanted === "active" && slot.status !== "active") {
      const { error } = await sb.from("ad_slots").update({ status: "active" }).eq("id", slot.id).eq("owner_id", userId);
      if (!error) slot = { ...slot, status: "active" };
    }
  } else {
    const payload: Record<string, unknown> = {
      project_id: project.id,
      owner_id: userId,
      status: request.status ?? "active",
      placement: request.placement ?? "inline",
    };
    if (request.formats) payload.formats = request.formats;
    if (project.organization_id) payload.organization_id = project.organization_id;
    let inserted = await sb.from("ad_slots").insert(payload).select(select).single();
    if (inserted.error && /organization_id|schema cache|column/i.test(inserted.error.message ?? "")) {
      delete payload.organization_id;
      inserted = await sb.from("ad_slots").insert(payload).select(select).single();
    }
    if (inserted.error || !inserted.data) return { ok: false, status: 500, error: inserted.error?.message ?? "Failed to create the slot." };
    slot = inserted.data as SlotRow;
  }
  if (!slot) return { ok: false, status: 500, error: "Failed to create the slot." };

  const tags = embedFor(input.siteUrl, slot.id, project.id, unitFormat);
  return {
    ok: true,
    slot: {
      ...slot,
      site: host,
      existing: wasExisting || undefined,
      ...tags,
      dashboard_url: `${input.siteUrl.replace(/\/$/, "")}/dashboard/ads/slots`,
    },
  };
}

export async function listSlots(input: { sb: SupabaseClient; userId: string; siteUrl: string }): Promise<Omit<SlotSummary, "embed" | "tracker" | "dashboard_url">[]> {
  const { data } = await input.sb
    .from("ad_slots")
    .select("id, status, placement, formats, project_id, created_at, projects(url)")
    .eq("owner_id", input.userId)
    .order("created_at", { ascending: false })
    .limit(200);
  return ((data as Record<string, unknown>[]) ?? []).map((row) => {
    const project = row.projects as { url?: string } | { url?: string }[] | null;
    const url = Array.isArray(project) ? project[0]?.url : project?.url;
    return {
      id: String(row.id),
      status: String(row.status),
      placement: String(row.placement),
      formats: (row.formats as string[]) ?? [],
      project_id: String(row.project_id),
      site: hostOf(url ?? "") ?? url ?? "",
      created_at: row.created_at as string | undefined,
    };
  });
}
