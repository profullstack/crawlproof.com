// The affiliate side of the spec: find a merchant's descriptor, join a
// program, read a ledger, and read an OpenProfile.md. Plain fetch with
// timeouts and size caps; no Supabase here, so the CLI can use it directly.

import {
  WELL_KNOWN_PATH,
  isVerifiedOrigin,
  parseDescriptor,
  readProfile,
  type Descriptor,
  type Pays,
  type ProfileFacts,
  type Program,
} from "./spec";

const UA = "openaffiliate-reader (crawlproof.com)";
const MAX_BYTES = 512 * 1024;

async function fetchText(url: string, accept: string): Promise<{ ok: true; text: string; headers: Headers; url: string } | { ok: false; error: string; status?: number }> {
  try {
    const res = await fetch(url, {
      headers: { accept, "user-agent": UA },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return { ok: false, error: "response over 512 KB" };
    return { ok: true, text: new TextDecoder().decode(buf), headers: res.headers, url: res.url || url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type Discovered = {
  ok: true;
  descriptor: Descriptor;
  fetchedFrom: string;
  origin: string;
  verified: boolean;
  warnings: string[];
  raw: unknown;
};
export type DiscoverResult = Discovered | { ok: false; error: string };

function originOf(input: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    return u.origin;
  } catch {
    return null;
  }
}

function linkRelFromHtml(html: string, base: string): string | null {
  const m = html.match(/<link\b[^>]*rel=["']?openaffiliate["']?[^>]*>/i);
  if (!m) return null;
  const href = m[0].match(/href=["']([^"']+)["']/i)?.[1];
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function linkRelFromHeader(header: string | null, base: string): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel=["']?openaffiliate["']?/i);
    if (m) {
      try {
        return new URL(m[1], base).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function tryDescriptor(url: string, origin: string): Promise<DiscoverResult> {
  const got = await fetchText(url, "application/json");
  if (!got.ok) return { ok: false, error: `${url}: ${got.error}` };
  let raw: unknown;
  try {
    raw = JSON.parse(got.text);
  } catch {
    return { ok: false, error: `${url} is not JSON.` };
  }
  const parsed = parseDescriptor(raw);
  if (!parsed.ok) return { ok: false, error: `${url}: ${parsed.error}` };
  return {
    ok: true,
    descriptor: parsed.descriptor,
    fetchedFrom: got.url,
    origin,
    verified: isVerifiedOrigin(got.url, parsed.descriptor.merchant.web ?? origin),
    warnings: parsed.warnings,
    raw,
  };
}

/**
 * Find a merchant's descriptor the three ways the spec names, in order:
 * /.well-known/openaffiliate.json, a rel="openaffiliate" link or header on
 * the home page, or the URL given directly when it is a JSON file.
 */
export async function discoverDescriptor(input: string): Promise<DiscoverResult> {
  const origin = originOf(input);
  if (!origin) return { ok: false, error: "That is not a URL." };
  const direct = /^https?:\/\//i.test(input) && /\.json(\?|$)/i.test(input) ? input : null;

  const wellKnown = await tryDescriptor(`${origin}${WELL_KNOWN_PATH}`, origin);
  if (wellKnown.ok) return wellKnown;

  const home = await fetchText(`${origin}/`, "text/html");
  if (home.ok) {
    const rel = linkRelFromHeader(home.headers.get("link"), origin) ?? linkRelFromHtml(home.text, origin);
    if (rel) {
      const viaRel = await tryDescriptor(rel, origin);
      if (viaRel.ok) return viaRel;
    }
  }

  if (direct) {
    const given = await tryDescriptor(direct, origin);
    if (given.ok) return { ...given, verified: false };
  }
  return { ok: false, error: `No OpenAffiliate descriptor at ${origin}${WELL_KNOWN_PATH}, no rel="openaffiliate" link on its home page.` };
}

export type JoinAnswer = {
  membership: string;
  program: string;
  status: "active" | "pending" | "refused";
  code?: string;
  link?: string;
  token?: string;
  ledger?: string;
  pays?: Pays[];
};

export async function joinProgram(
  program: Program,
  body: { program?: string; profile: string; pay?: string; webhook?: string; code?: string },
): Promise<{ ok: true; answer: JoinAnswer; raw: Record<string, unknown> } | { ok: false; error: string }> {
  if (!program.join) return { ok: false, error: `${program.title} has no join URL; join it by hand at ${program.url ?? "the merchant"}.` };
  if (program.status !== "active") return { ok: false, error: `${program.title} is ${program.status} and takes no joins.` };
  let res: Response;
  try {
    res = await fetch(program.join, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
      body: JSON.stringify({ program: program.id, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let raw: Record<string, unknown>;
  try {
    raw = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `The merchant answered ${res.status} without JSON.` };
  }
  if (!res.ok) return { ok: false, error: String(raw.error ?? `The merchant answered ${res.status}.`) };
  const status = raw.status === "pending" || raw.status === "refused" ? raw.status : "active";
  if (typeof raw.membership !== "string") return { ok: false, error: "The merchant's answer has no membership id." };
  return {
    ok: true,
    answer: {
      membership: raw.membership,
      program: typeof raw.program === "string" ? raw.program : program.id,
      status,
      code: typeof raw.code === "string" ? raw.code : undefined,
      link: typeof raw.link === "string" ? raw.link : undefined,
      token: typeof raw.token === "string" ? raw.token : undefined,
      ledger: typeof raw.ledger === "string" ? raw.ledger : program.ledger,
      pays: Array.isArray(raw.pays) ? (raw.pays as Pays[]) : program.pays,
    },
    raw,
  };
}

export async function readLedger(ledgerUrl: string, token: string, since?: string): Promise<{ ok: true; ledger: Record<string, unknown> } | { ok: false; error: string; status?: number }> {
  const u = new URL(ledgerUrl);
  if (since) u.searchParams.set("since", since);
  try {
    const res = await fetch(u.toString(), {
      headers: { accept: "application/json", authorization: `Bearer ${token}`, "user-agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    return { ok: true, ledger: (await res.json()) as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchProfile(url: string): Promise<{ ok: true; facts: ProfileFacts; markdown: string } | { ok: false; error: string }> {
  const got = await fetchText(url, "text/markdown, text/plain;q=0.9, */*;q=0.1");
  if (!got.ok) return { ok: false, error: got.error };
  if (/^\s*</.test(got.text) && /<html/i.test(got.text)) return { ok: false, error: "that URL is an HTML page, not an OpenProfile.md" };
  return { ok: true, facts: readProfile(got.text), markdown: got.text };
}
