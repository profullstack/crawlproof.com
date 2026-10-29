// Scan leads into OutreachGraph.
//
// Everyone who asked for a report PDF left an email and the site they care
// about. OutreachGraph is where leads are worked, so each new address goes
// there once as a contact, with the scanned site as its company domain. The
// company is what travels further: OutreachGraph's public directory lists
// companies by domain and nichedb reads that directory. People never become
// public anywhere; an email only ever reaches OutreachGraph's private,
// workspace-scoped import.
//
// The selection is pure so the rule about who leaves this database can be
// tested without OutreachGraph attached.

import { isThirdPartyHost } from "@/lib/leadCampaign";

export const LEAD_EXPORT_DESTINATION = "outreachgraph";

/** Addresses that are ours or not a person: never exported. */
const INTERNAL = /@(profullstack\.com|crawlproof\.com)$/i;
const ROLE_LOCALPART =
  /^(postmaster|abuse|noreply|no-reply|donotreply|mailer-daemon|admin|webmaster|hostmaster)@/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ScanLead = {
  email: string;
  targetUrl: string | null;
  unsubscribedAt: string | null;
  consentedAt: string | null;
};

export type ExportRow = {
  email: string;
  /** The scanned site, when it is one the person could own. */
  companyDomain?: string;
  /** opt_in when they ticked the marketing box, else the report request. */
  consentBasis: "opt_in" | "report_request";
};

/** `https://www.Acme.com/pricing` → `acme.com`. Null when it is not a URL. */
export function hostOf(targetUrl: string | null): string | null {
  if (!targetUrl) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/**
 * The leads not yet exported, one row per address, newest scan first in
 * `leads` (so the company is the site they scanned most recently).
 * Unsubscribed addresses never leave, even if they were never exported.
 */
export function selectExports(leads: ScanLead[], alreadyExported: Set<string>): ExportRow[] {
  const out: ExportRow[] = [];
  const seen = new Set<string>();
  for (const lead of leads) {
    const email = lead.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (!EMAIL.test(email) || INTERNAL.test(email) || ROLE_LOCALPART.test(email)) continue;
    if (lead.unsubscribedAt || alreadyExported.has(email)) continue;
    const host = hostOf(lead.targetUrl);
    out.push({
      email,
      ...(host && !isThirdPartyHost(host) ? { companyDomain: host } : {}),
      consentBasis: lead.consentedAt ? "opt_in" : "report_request",
    });
  }
  return out;
}

type Fetch = typeof fetch;

/**
 * One OutreachGraph contact import per consent basis: start, rows in chunks
 * of 500 (its limit), finish with enrichment on. Returns the import ids.
 */
export async function pushToOutreachGraph(
  rows: ExportRow[],
  opts: { apiUrl: string; apiKey: string; fetch?: Fetch },
): Promise<Array<{ importId: string; basis: string; emails: string[] }>> {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.apiUrl.replace(/\/$/, "");
  const call = async (path: string, body: unknown) => {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OutreachGraph ${path} answered ${res.status}: ${text.slice(0, 200)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  const done: Array<{ importId: string; basis: string; emails: string[] }> = [];
  for (const basis of ["opt_in", "report_request"] as const) {
    const batch = rows.filter((r) => r.consentBasis === basis);
    if (batch.length === 0) continue;
    const started = await call("/contacts/imports", {
      filename: `crawlproof-scan-leads-${new Date().toISOString().slice(0, 10)}`,
      consentBasis: basis,
      consentSource: "crawlproof.com scan report (PDF request)",
    });
    const importId = String(started.importId ?? "");
    if (!importId) throw new Error("OutreachGraph started an import without an id");
    for (let i = 0; i < batch.length; i += 500) {
      await call(`/contacts/imports/${encodeURIComponent(importId)}/rows`, {
        startRow: i,
        rows: batch.slice(i, i + 500).map((r) => ({
          email: r.email,
          ...(r.companyDomain ? { companyDomain: r.companyDomain } : {}),
        })),
      });
    }
    await call(`/contacts/imports/${encodeURIComponent(importId)}/finish`, { enrich: true });
    done.push({ importId, basis, emails: batch.map((r) => r.email) });
  }
  return done;
}
