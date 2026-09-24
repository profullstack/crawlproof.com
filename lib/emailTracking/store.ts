// Email tracking: the database half. Service role throughout, because the
// public routes (/t/**) have no session and email_tracking has no policy for
// authenticated users (the secret must not be readable by read-only members).
// Callers from the dashboard gate on requireProjectAccess first.

import crypto from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";
import type { EmailEventType } from "@/lib/emailTracking/core";

export type TrackingRow = {
  project_id: string;
  tracking_id: string;
  secret: string;
  previous_secret: string | null;
  secret_rotated_at: string | null;
  enabled: boolean;
  enabled_at: string | null;
};

const COLUMNS =
  "project_id, tracking_id, secret, previous_secret, secret_rotated_at, enabled, enabled_at";

export async function findByTrackingId(trackingId: string): Promise<TrackingRow | null> {
  const { data, error } = await serviceClient()
    .from("email_tracking")
    .select(COLUMNS)
    .eq("tracking_id", trackingId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TrackingRow | null) ?? null;
}

/**
 * The project's row, created on the spot if the insert trigger somehow did
 * not run (a project restored from a dump, say). The tab must never show
 * "no tracking id".
 */
export async function getOrCreateForProject(projectId: string): Promise<TrackingRow> {
  const sb = serviceClient();
  const { data } = await sb.from("email_tracking").select(COLUMNS).eq("project_id", projectId).maybeSingle();
  if (data) return data as TrackingRow;
  const { data: created, error } = await sb
    .from("email_tracking")
    .upsert({ project_id: projectId }, { onConflict: "project_id", ignoreDuplicates: false })
    .select(COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return created as TrackingRow;
}

export async function setEnabled(projectId: string, enabled: boolean): Promise<TrackingRow> {
  await getOrCreateForProject(projectId);
  const patch: Record<string, unknown> = { enabled };
  if (enabled) patch.enabled_at = new Date().toISOString();
  const { data, error } = await serviceClient()
    .from("email_tracking")
    .update(patch)
    .eq("project_id", projectId)
    .select(COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return data as TrackingRow;
}

/**
 * New secret. The old one moves to previous_secret so links in mail that has
 * already gone out (above all, unsubscribe links) keep verifying until the
 * next rotation.
 */
export async function rotateSecret(projectId: string): Promise<TrackingRow> {
  const current = await getOrCreateForProject(projectId);
  const { data, error } = await serviceClient()
    .from("email_tracking")
    .update({
      secret: crypto.randomBytes(32).toString("hex"),
      previous_secret: current.secret,
      secret_rotated_at: new Date().toISOString(),
    })
    .eq("project_id", projectId)
    .select(COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return data as TrackingRow;
}

export type NewEvent = {
  project_id: string;
  type: EmailEventType;
  m: string | null;
  c: string | null;
  v: string | null;
  url?: string | null;
  email?: string | null;
  machine?: boolean;
  visitor_hash?: string | null;
};

/** Insert one event. Returns false (without throwing) for a duplicate unsubscribe. */
export async function insertEvent(ev: NewEvent): Promise<boolean> {
  const { error } = await serviceClient().from("email_tracking_events").insert({
    project_id: ev.project_id,
    type: ev.type,
    m: ev.m,
    c: ev.c,
    v: ev.v,
    url: ev.type === "click" ? ev.url ?? null : null,
    email: ev.type === "unsubscribe" ? ev.email ?? null : null,
    machine: ev.machine ?? false,
    visitor_hash: ev.visitor_hash ?? null,
  });
  if (!error) return true;
  // email_tracking_events_unsub_once_idx: already unsubscribed is success.
  if ((error as { code?: string }).code === "23505") return false;
  throw new Error(error.message);
}

/** When this message id was first seen on this project, if ever. */
export async function firstSighting(projectId: string, m: string): Promise<Date | null> {
  const { data } = await serviceClient()
    .from("email_tracking_events")
    .select("at")
    .eq("project_id", projectId)
    .eq("m", m)
    .order("at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const at = (data as { at?: string } | null)?.at;
  return at ? new Date(at) : null;
}

export type EventRow = {
  id: number;
  type: EmailEventType;
  m: string | null;
  c: string | null;
  v: string | null;
  url: string | null;
  email: string | null;
  machine: boolean;
  at: string;
};

/** One page of events in id order, strictly after `afterId`. */
export async function listEvents(input: {
  projectId: string;
  since: string | null;
  type: EmailEventType | null;
  afterId: number | null;
  limit: number;
}): Promise<EventRow[]> {
  let q = serviceClient()
    .from("email_tracking_events")
    .select("id, type, m, c, v, url, email, machine, at")
    .eq("project_id", input.projectId);
  if (input.since) q = q.gte("at", input.since);
  if (input.type) q = q.eq("type", input.type);
  if (input.afterId !== null) q = q.gt("id", input.afterId);
  const { data, error } = await q.order("id", { ascending: true }).limit(input.limit);
  if (error) throw new Error(error.message);
  return (data as EventRow[] | null) ?? [];
}
