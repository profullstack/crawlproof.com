// Funnel constants and parsers shared by the browser beacon and the server.
// No server imports here: this file ships to the client.

export const FUNNEL_SOURCES = ["organic", "outreach", "ranking"] as const;
export type FunnelSource = (typeof FUNNEL_SOURCES)[number];

export const FUNNEL_EVENTS = [
  "audit_started",
  "audit_completed",
  "report_viewed",
  "signup",
  "checkout_started",
  "subscribed",
] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

export const SOURCE_COOKIE = "cp_src";
export const VISITOR_COOKIE = "cp_vid";
export const SOURCE_COOKIE_DAYS = 30;

export function parseSource(v: unknown): FunnelSource | null {
  return typeof v === "string" && (FUNNEL_SOURCES as readonly string[]).includes(v)
    ? (v as FunnelSource)
    : null;
}

export function isFunnelEvent(v: unknown): v is FunnelEvent {
  return typeof v === "string" && (FUNNEL_EVENTS as readonly string[]).includes(v);
}

/** Visitor ids are ours (crypto.randomUUID in the browser); anything else is dropped. */
export function parseVisitorId(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null;
}

export function readCookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
