// OpenAffiliate, the pure half: the descriptor a merchant serves, the join
// request an affiliate sends, and the arithmetic between them. No I/O, no
// env, no Supabase, so tests and the CLI can import it without a server.
// Spec: https://logicsrc.com/docs/openaffiliate

export const WELL_KNOWN_PATH = "/.well-known/openaffiliate.json";
export const DEFAULT_PARAM = "oa";
export const TOKEN_PREFIX = "oa_";

export const PAY_EVENTS = ["sale", "subscription", "signup", "lead", "install", "other"] as const;
export type PayEvent = (typeof PAY_EVENTS)[number];
export function isPayEvent(s: unknown): s is PayEvent {
  return typeof s === "string" && (PAY_EVENTS as readonly string[]).includes(s);
}

export type Pays = {
  event: PayEvent;
  kind: "percent" | "amount";
  value: number;
  /** subscription only: how many renewals pay; absent is every one */
  months?: number;
};

export type ProgramLink = {
  param: string;
  template?: string;
  deep: boolean;
  aliases: string[];
};

export type Payout = {
  methods: string[];
  min?: number;
  schedule?: "weekly" | "monthly" | "on_request";
};

export type Program = {
  id: string;
  title: string;
  url?: string;
  join?: string;
  ledger?: string;
  approval: "open" | "review";
  pays: Pays[];
  link: ProgramLink;
  window?: number;
  attribution: "last" | "first";
  hold_days?: number;
  payout?: Payout;
  disclosure?: string;
  self: "refused" | "allowed";
  regions?: string[];
  creatives?: string;
  status: "active" | "paused" | "closed";
  updated?: string;
  /** keys this module does not name, kept under the merchant's own names */
  extra: Record<string, unknown>;
};

export type Merchant = {
  name: string;
  web?: string;
  operator?: string;
  currency: string;
  terms?: string;
  jwks?: string;
  extra: Record<string, unknown>;
};

export type Descriptor = {
  merchant: Merchant;
  updated?: string;
  programs: Program[];
};

export type ParseResult =
  | { ok: true; descriptor: Descriptor; warnings: string[] }
  | { ok: false; error: string };

const MERCHANT_KEYS = new Set(["name", "web", "operator", "currency", "terms", "jwks"]);
const PROGRAM_KEYS = new Set([
  "id", "title", "url", "join", "ledger", "approval", "pays", "link", "window", "attribution",
  "hold_days", "payout", "disclosure", "self", "regions", "creatives", "status", "updated",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function httpUrl(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/** A code is what goes in ?oa=. Lower-case, 3 to 32 chars, dashes inside. */
export function isAffiliateCode(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(s);
}

/** A slug from anything, good enough to be a code or fall back to. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/** Derive a stable program id from its title when the merchant gave none. */
export function programIdFrom(p: { id?: string; title: string }): string {
  return p.id ?? slugify(p.title) ?? "default";
}

export function parsePays(v: unknown): { pays: Pays[]; warnings: string[] } {
  const warnings: string[] = [];
  const pays: Pays[] = [];
  if (!Array.isArray(v)) return { pays, warnings: ["pays is not a list"] };
  for (const raw of v) {
    if (!isObj(raw)) continue;
    const event = raw.event;
    if (!isPayEvent(event)) {
      warnings.push(`pays entry with unknown event ${JSON.stringify(event)} dropped`);
      continue;
    }
    const kind = raw.kind === "amount" ? "amount" : raw.kind === "percent" ? "percent" : null;
    const value = num(raw.value);
    if (!kind || value === undefined || value < 0) {
      warnings.push(`pays entry for ${event} needs kind percent|amount and a value`);
      continue;
    }
    if (kind === "percent" && value > 100) {
      warnings.push(`pays entry for ${event} is over 100 percent`);
      continue;
    }
    const months = num(raw.months);
    pays.push({
      event,
      kind,
      value,
      ...(months !== undefined && months > 0 ? { months: Math.floor(months) } : {}),
    });
  }
  return { pays, warnings };
}

export function parseProgram(raw: unknown, index: number): { program?: Program; warnings: string[] } {
  const warnings: string[] = [];
  if (!isObj(raw)) return { warnings: [`programs[${index}] is not an object`] };
  const title = str(raw.title);
  if (!title) return { warnings: [`programs[${index}] has no title`] };
  const { pays, warnings: payWarnings } = parsePays(raw.pays);
  warnings.push(...payWarnings.map((w) => `${title}: ${w}`));
  if (!pays.length) return { warnings: [...warnings, `${title}: pays nothing, dropped`] };

  const linkRaw = isObj(raw.link) ? raw.link : {};
  const param = str(linkRaw.param) ?? DEFAULT_PARAM;
  const aliases = Array.isArray(linkRaw.aliases)
    ? linkRaw.aliases.filter((a): a is string => typeof a === "string" && a.length > 0)
    : [];
  const link: ProgramLink = {
    param,
    template: str(linkRaw.template),
    deep: linkRaw.deep === true,
    aliases,
  };

  let payout: Payout | undefined;
  if (isObj(raw.payout)) {
    const methods = Array.isArray(raw.payout.methods)
      ? raw.payout.methods.filter((m): m is string => typeof m === "string" && m.length > 0)
      : [];
    const schedule = raw.payout.schedule;
    payout = {
      methods,
      min: num(raw.payout.min),
      schedule:
        schedule === "weekly" || schedule === "monthly" || schedule === "on_request"
          ? schedule
          : undefined,
    };
  }

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!PROGRAM_KEYS.has(k)) extra[k] = v;

  const status = raw.status;
  const program: Program = {
    id: str(raw.id) ?? programIdFrom({ title }),
    title,
    url: httpUrl(raw.url),
    join: httpUrl(raw.join),
    ledger: httpUrl(raw.ledger),
    approval: raw.approval === "open" ? "open" : "review",
    pays,
    link,
    window: num(raw.window),
    attribution: raw.attribution === "first" ? "first" : "last",
    hold_days: num(raw.hold_days),
    payout,
    disclosure: str(raw.disclosure),
    self: raw.self === "allowed" ? "allowed" : "refused",
    regions: Array.isArray(raw.regions)
      ? raw.regions.filter((r): r is string => typeof r === "string")
      : undefined,
    creatives: httpUrl(raw.creatives),
    status: status === "paused" || status === "closed" ? status : "active",
    updated: str(raw.updated),
    extra,
  };
  return { program, warnings };
}

/** Parse a merchant's descriptor. Lenient by design: every rule degrades. */
export function parseDescriptor(input: unknown): ParseResult {
  if (!isObj(input)) return { ok: false, error: "The descriptor is not a JSON object." };
  if (!isObj(input.merchant)) return { ok: false, error: "The descriptor has no merchant." };
  const name = str(input.merchant.name);
  if (!name) return { ok: false, error: "merchant.name is required." };

  const mExtra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.merchant)) if (!MERCHANT_KEYS.has(k)) mExtra[k] = v;
  const merchant: Merchant = {
    name,
    web: httpUrl(input.merchant.web),
    operator: httpUrl(input.merchant.operator),
    currency: (str(input.merchant.currency) ?? "USD").toUpperCase(),
    terms: httpUrl(input.merchant.terms),
    jwks: httpUrl(input.merchant.jwks),
    extra: mExtra,
  };

  if (!Array.isArray(input.programs) || !input.programs.length) {
    return { ok: false, error: "The descriptor lists no programs." };
  }
  const warnings: string[] = [];
  const programs: Program[] = [];
  const seen = new Set<string>();
  input.programs.forEach((raw, i) => {
    const { program, warnings: w } = parseProgram(raw, i);
    warnings.push(...w);
    if (!program) return;
    if (seen.has(program.id)) {
      warnings.push(`duplicate program id ${program.id} dropped`);
      return;
    }
    seen.add(program.id);
    programs.push(program);
  });
  if (!programs.length) return { ok: false, error: "No program in the descriptor pays anything." };

  return { ok: true, descriptor: { merchant, updated: str(input.updated), programs }, warnings };
}

/** The commission one conversion earns, in cents. 0 when the event is unpaid. */
export function commissionCents(
  pays: Pays[],
  event: PayEvent,
  amountCents: number,
  renewalN?: number,
): number {
  const entry = pays.find((p) => p.event === event);
  if (!entry) return 0;
  if (entry.event === "subscription" && entry.months && renewalN && renewalN > entry.months) return 0;
  if (entry.kind === "amount") return Math.max(0, Math.round(entry.value * 100));
  return Math.max(0, Math.round((Math.max(0, amountCents) * entry.value) / 100));
}

/** The link an affiliate hands out: a deep URL when the program allows it, else the template, else web + param. */
export function linkFor(
  program: Pick<Program, "link" | "url">,
  code: string,
  web?: string,
  deepUrl?: string,
): string | null {
  const param = program.link.param || DEFAULT_PARAM;
  if (deepUrl && program.link.deep) {
    try {
      const u = new URL(deepUrl);
      u.searchParams.set(param, code);
      return u.toString();
    } catch {
      /* fall through to the template */
    }
  }
  if (program.link.template) return program.link.template.replaceAll("{code}", encodeURIComponent(code));
  const base = web ?? program.url;
  if (!base) return null;
  try {
    const u = new URL(base);
    u.searchParams.set(param, code);
    return u.toString();
  } catch {
    return null;
  }
}

/** A descriptor is verified when it came from the merchant's own origin (spec, "Discovery"). */
export function isVerifiedOrigin(fetchedFrom: string, merchantWeb?: string): boolean {
  try {
    const from = new URL(fetchedFrom);
    if (from.pathname === WELL_KNOWN_PATH) return true;
    if (!merchantWeb) return false;
    return new URL(merchantWeb).origin === from.origin;
  } catch {
    return false;
  }
}

// ─── Join ───────────────────────────────────────────────────────────────────

export type JoinRequest = {
  program?: string;
  profile: string;
  pay?: string;
  webhook?: string;
  code?: string;
};

export type JoinParse = { ok: true; request: JoinRequest } | { ok: false; error: string };

/** CAIP-10 (`eip155:137:0x…`) or a bare EVM address. Anything else is refused. */
export function isPayAddress(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const bare = s.includes(":") ? s.split(":").pop() ?? "" : s;
  return /^0x[0-9a-fA-F]{40}$/.test(bare);
}

/** The wallet part of a pay address, for the payout rail. */
export function walletOf(pay: string): string {
  return pay.includes(":") ? (pay.split(":").pop() ?? pay) : pay;
}

export function parseJoinRequest(body: unknown): JoinParse {
  if (!isObj(body)) return { ok: false, error: "Send a JSON object." };
  const profile = httpUrl(body.profile);
  if (!profile) return { ok: false, error: "profile is required and must be an https URL to an OpenProfile.md." };
  const request: JoinRequest = { profile };
  const program = str(body.program);
  if (program) request.program = program;
  if (body.pay !== undefined && body.pay !== null && body.pay !== "") {
    if (!isPayAddress(body.pay)) return { ok: false, error: "pay must be an EVM address or a CAIP-10 account (eip155:137:0x…)." };
    request.pay = body.pay;
  }
  if (body.webhook !== undefined && body.webhook !== null && body.webhook !== "") {
    const webhook = httpUrl(body.webhook);
    if (!webhook || !webhook.startsWith("https://")) return { ok: false, error: "webhook must be an https URL." };
    request.webhook = webhook;
  }
  if (body.code !== undefined && body.code !== null && body.code !== "") {
    if (!isAffiliateCode(body.code)) return { ok: false, error: "code must be 3 to 32 lower-case letters, digits or dashes." };
    request.code = body.code;
  }
  return { ok: true, request };
}

// ─── OpenProfile.md, the little we read of it ────────────────────────────────

export type ProfileFacts = {
  name?: string;
  kind: "person" | "agent" | "organization";
  handle?: string;
  email?: string;
  pay?: string;
  web?: string;
  operator?: string;
  /** every URL in the Accounts section, for the rel=me style link-back check */
  accounts: string[];
};

/** Read the identity block and the Accounts list of an OpenProfile.md. */
export function readProfile(markdown: string): ProfileFacts {
  const facts: ProfileFacts = { kind: "person", accounts: [] };
  const lines = markdown.split(/\r?\n/);
  let section = "";
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1 && !facts.name) {
      facts.name = h1[1];
      continue;
    }
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      section = h2[1].trim().toLowerCase();
      continue;
    }
    const kv = line.match(/^(?:[-*]\s*)?\*{0,2}([A-Za-z][A-Za-z ]{0,20})\*{0,2}\s*:\s*(.+?)\s*$/);
    if (kv && !section) {
      const key = kv[1].trim().toLowerCase();
      const value = kv[2].trim();
      if (key === "kind") {
        facts.kind = value.toLowerCase() === "agent" ? "agent" : value.toLowerCase() === "organization" ? "organization" : "person";
      } else if (key === "handle") facts.handle = value.replace(/^@/, "");
      else if (key === "email") facts.email = value.replace(/^<|>$/g, "");
      else if (key === "pay") facts.pay = value;
      else if (key === "web") facts.web = value;
      continue;
    }
    if (section === "accounts") {
      const urls = line.match(/https?:\/\/[^\s)>\]]+/g);
      if (urls) facts.accounts.push(...urls);
    }
    if (section === "operator") {
      const url = line.match(/https?:\/\/[^\s)>\]]+/);
      if (url && !facts.operator) facts.operator = url[0];
    }
  }
  return facts;
}

/** A code suggestion from a profile: the handle, else the name, else the host. */
export function codeFromProfile(profileUrl: string, facts?: Pick<ProfileFacts, "handle" | "name">): string {
  const fromHandle = facts?.handle ? slugify(facts.handle) : "";
  if (isAffiliateCode(fromHandle)) return fromHandle;
  const fromName = facts?.name ? slugify(facts.name) : "";
  if (isAffiliateCode(fromName)) return fromName;
  try {
    const host = new URL(profileUrl).hostname.replace(/^www\./, "");
    const label = slugify(host.split(".")[0] ?? host);
    if (isAffiliateCode(label)) return label;
    const whole = slugify(host);
    if (isAffiliateCode(whole)) return whole;
  } catch {
    /* fall through */
  }
  return "partner";
}
