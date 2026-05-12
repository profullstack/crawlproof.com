import crypto from "node:crypto";
import { serviceClient } from "./supabase/service";

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|fc00:|fd00:)/i;

export function hashIp(ip: string | null | undefined): string {
  const v = ip ?? "unknown";
  return crypto.createHash("sha256").update(`crawlproof:${v}`).digest("hex").slice(0, 32);
}

export function isAllowedTargetUrl(input: string): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: "Only http(s) URLs are supported." };
  if (PRIVATE_HOST.test(url.hostname)) return { ok: false, reason: "Refusing to audit private or localhost addresses." };
  return { ok: true, url: url.toString() };
}

// Anonymous: 3 audits per IP per day.
export async function checkAnonymousLimit(ipHash: string): Promise<{ ok: boolean; remaining: number }> {
  const supabase = serviceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .eq("kind", "audit_run")
    .gte("created_at", since);
  if (error) return { ok: true, remaining: 3 };
  const used = count ?? 0;
  return { ok: used < 3, remaining: Math.max(0, 3 - used) };
}

// Per-target: 1 audit per URL per 5 minutes.
export async function checkPerTargetLimit(target: string, ownerId: string | null): Promise<boolean> {
  const supabase = serviceClient();
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let q = supabase
    .from("audits")
    .select("id", { count: "exact", head: true })
    .eq("target_url", target)
    .gte("created_at", since);
  if (ownerId) q = q.eq("owner_id", ownerId);
  const { count, error } = await q;
  if (error) return true;
  return (count ?? 0) === 0;
}

// Monthly tier limits.
export async function checkMonthlyLimit(
  ownerId: string,
  plan: "free" | "pro" | "team",
): Promise<{ ok: boolean; used: number; cap: number }> {
  const caps = { free: 10, pro: 200, team: 1000 } as const;
  const cap = caps[plan];
  const supabase = serviceClient();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("audits")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId)
    .gte("created_at", since);
  const used = count ?? 0;
  return { ok: used < cap, used, cap };
}
