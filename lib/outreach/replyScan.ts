// Reply detection: read the mailbox we sent from and notice who answered.
//
// The funnel could count sends and nothing else, because a send is something
// this application does and a reply is something that happens somewhere else.
// Everything past "contacted" therefore depended on a human remembering to
// mark it, which means a reply rate of structurally zero for anyone who did
// not — and a rate of zero is worse than no rate, because it reads as a
// verdict on the campaign rather than on the bookkeeping.
//
// The mailbox connected in #126 already stores IMAP settings and an encrypted
// password. This is what finally reads them.
//
// The judgement call throughout is what counts as a reply. An out-of-office is
// not one. A bounce is not one. Both arrive addressed exactly like one, and
// counting either would inflate the single number this exists to report — so
// they are recorded, flagged, and kept out of the count.

import { serviceClient } from "@/lib/supabase/service";
import { decryptSecret } from "@/lib/sp/vault";

/** How far back a mailbox with no cursor looks on its first scan. */
const FIRST_SCAN_DAYS = 14;
/**
 * Ceiling per mailbox per run, so one busy inbox cannot hold up the rest.
 *
 * Applied to the newest messages in the window rather than the first ones the
 * server hands over. A cap on an oldest-first walk silently reads two-week-old
 * mail forever and never sees today's replies.
 */
const MAX_MESSAGES_PER_SCAN = 200;
const SNIPPET_CHARS = 280;

export type ReplyMailbox = {
  configId: string;
  organizationId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  lastScanAt: Date | null;
};

// ---------------------------------------------------------------- classify

/**
 * Headers that mean a machine sent this.
 *
 * RFC 3834 defines Auto-Submitted for exactly this purpose and the value "no"
 * is the one that means a human. Everything else here is what real mail
 * systems send instead of implementing it.
 */
const AUTO_HEADERS: Array<[string, RegExp]> = [
  ["auto-submitted", /^(?!no\b)/i],
  ["precedence", /\b(bulk|auto_reply|junk|list)\b/i],
  ["x-autoreply", /./],
  ["x-autorespond", /./],
  ["x-auto-response-suppress", /./],
  ["x-mailer-daemon-error", /./],
  ["list-id", /./],
  // Bulk-mail fingerprints. A company we contacted may also be sending us
  // their newsletter, and it arrives from a real human-looking address at the
  // right domain — the exact shape of a reply, carrying none of its meaning.
  ["list-unsubscribe", /./],
  ["feedback-id", /./],
  ["x-campaign", /./],
  ["x-campaignid", /./],
  ["x-mailchimp-id", /./],
  ["x-csa-complaints", /./],
];

const AUTO_SUBJECT =
  // "Auto:" with the colon is Outlook's out-of-office prefix. The colon is
  // what keeps it from matching a person writing about automobiles.
  /^\s*(re:\s*)?(out of (the )?office|automatic(ally)? repl|auto(-| )?repl|autoreply|auto:\s|undeliverable|undelivered|delivery (status notification|has failed|failure)|mail delivery (failed|subsystem)|returned mail|absence|away from|vacation|thank you for (your|contacting)|we('| ha)ve received your)/i;

const AUTO_SENDER =
  /^(mailer-daemon|postmaster|no-?reply|noreply|do-?not-?reply|bounce|bounces|notifications?|automated?|support-?bot)@/i;

/**
 * Whether a message is a machine's answer rather than a person's.
 *
 * Biased towards calling things automatic. A human reply wrongly flagged shows
 * up in the list for the user to correct; an out-of-office wrongly counted
 * silently inflates the reply rate on every campaign that touches a company
 * with a holiday policy.
 */
export function isAutoReply(input: {
  headers: Record<string, string>;
  subject: string | null;
  from: string;
}): boolean {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) h[k.toLowerCase()] = v;

  for (const [name, pattern] of AUTO_HEADERS) {
    const value = h[name];
    if (value !== undefined && pattern.test(value.trim())) return true;
  }
  if (input.subject && AUTO_SUBJECT.test(input.subject)) return true;
  if (AUTO_SENDER.test(input.from.trim().toLowerCase())) return true;
  return false;
}

/** Parse a raw header block into a lowercase-keyed map. Folded lines are joined. */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let currentKey = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // A leading space or tab continues the previous header rather than
    // starting a new one — long References lists arrive folded this way.
    if (/^[ \t]/.test(line) && currentKey) {
      out[currentKey] += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    currentKey = line.slice(0, idx).trim().toLowerCase();
    out[currentKey] = line.slice(idx + 1).trim();
  }
  return out;
}

/**
 * A readable excerpt of the message.
 *
 * Quoted history is dropped: nearly every reply carries a copy of the mail we
 * sent, and an excerpt of our own outreach tells the reader nothing about the
 * answer.
 */
export function snippetOf(body: string): string {
  const withoutHtml = decodeQuotedPrintable(body)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const lines = withoutHtml.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(">")) break; // quoted original
    if (/^on .{0,80}\bwrote:$/i.test(t)) break; // the usual attribution line
    if (/^-{2,}\s*(original message|forwarded message)/i.test(t)) break;
    if (/^from:\s.+@/i.test(t) && kept.length) break; // Outlook's quoting style
    kept.push(t);
  }
  return kept
    .join(" ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SNIPPET_CHARS);
}

/**
 * Whether this message is a response to something rather than a fresh send.
 *
 * A reply carries threading headers or a Re: subject. Requiring one of those
 * is what stops a company's marketing list — which arrives from their domain,
 * from a plausible address, addressed to us — from being counted as an answer
 * to a pitch nobody read.
 */
export function looksLikeResponse(input: {
  headers: Record<string, string>;
  subject: string | null;
}): boolean {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) h[k.toLowerCase()] = v;
  if (h["in-reply-to"] || h["references"]) return true;
  return /^\s*(re|aw|sv|antw|res|r)\s*:/i.test(input.subject ?? "");
}

/** Message-Ids this message claims to answer, from either threading header. */
export function referencedMessageIds(headers: Record<string, string>): string[] {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const raw = `${h["in-reply-to"] ?? ""} ${h["references"] ?? ""}`;
  return [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
}

/**
 * Undo quoted-printable, which is how most mail encodes anything non-ASCII.
 *
 * Without it an em-dash arrives as "=E2=80=94" and a snippet of a perfectly
 * ordinary sentence reads as line noise. Applied unconditionally: the encoding
 * is a no-op on text that does not use it.
 */
export function decodeQuotedPrintable(text: string): string {
  const unfolded = text.replace(/=\r?\n/g, "");
  // Runs of =XX are decoded together so multi-byte UTF-8 sequences survive;
  // decoding each byte separately would produce mojibake for every accent.
  return unfolded.replace(/(?:=[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = Buffer.from(
      run.split("=").filter(Boolean).map((h) => parseInt(h, 16)),
    );
    return bytes.toString("utf8");
  });
}

/** The bare address out of a From header or an envelope entry. */
export function addressOf(value: string | null | undefined): string {
  if (!value) return "";
  const angled = value.match(/<([^>]+)>/);
  const raw = angled ? angled[1] : value;
  return raw.trim().toLowerCase();
}

// ------------------------------------------------------------------ loading

/** Mailboxes with usable IMAP settings. A send-only mailbox cannot be scanned. */
export async function loadReplyMailboxes(): Promise<ReplyMailbox[]> {
  const sb = serviceClient();
  const { data } = await sb
    .from("organization_outreach_configs")
    .select(
      "id, organization_id, from_email, imap_host, imap_port, imap_secure, imap_user, enc_smtp_user, enc_smtp_pass, last_reply_scan_at",
    )
    .eq("channel", "email")
    .eq("provider", "smtp")
    .eq("enabled", true)
    .not("imap_host", "is", null);

  const out: ReplyMailbox[] = [];
  for (const r of (data as Record<string, unknown>[] | null) ?? []) {
    const host = (r.imap_host as string | null) ?? "";
    const fromEmail = (r.from_email as string | null) ?? "";
    const encPass = r.enc_smtp_pass as string | null;
    if (!host || !fromEmail || !encPass) continue;
    try {
      out.push({
        configId: r.id as string,
        organizationId: r.organization_id as string,
        host,
        port: (r.imap_port as number | null) ?? 993,
        secure: (r.imap_secure as boolean | null) ?? true,
        // The IMAP username is usually the SMTP one; fall back to the address.
        user:
          (r.imap_user as string | null) ??
          (r.enc_smtp_user ? decryptSecret(r.enc_smtp_user as string) : fromEmail),
        pass: decryptSecret(encPass),
        fromEmail,
        lastScanAt: r.last_reply_scan_at ? new Date(r.last_reply_scan_at as string) : null,
      });
    } catch {
      // A credential we cannot decrypt is skipped rather than failing the run;
      // the vault key may have rotated under an old row.
    }
  }
  return out;
}

/** Where a scan should start reading from. */
export function scanSince(lastScanAt: Date | null, now: Date): Date {
  if (!lastScanAt) return new Date(now.getTime() - FIRST_SCAN_DAYS * 86_400_000);
  // A day of overlap. IMAP SINCE has date granularity, and a reply that lands
  // mid-scan would otherwise fall in the gap between two runs.
  return new Date(lastScanAt.getTime() - 86_400_000);
}

// ------------------------------------------------------------------ matching

export type ReplyMatch = {
  projectId: string | null;
  ownerId: string;
  prospectId: string | null;
  sendId: string | null;
};

/**
 * Tie an incoming address back to something we sent.
 *
 * Two passes, because the address that answers is often not the address that
 * was written to: mail to info@ gets answered by a named person at the same
 * company. Matching the exact recipient first keeps that fallback from
 * claiming a reply for the wrong prospect when both exist.
 */
export async function matchReply(input: {
  organizationId: string;
  fromEmail: string;
  /** Message-Ids this mail answers, from In-Reply-To / References. */
  references?: string[];
  /** Whether it carries any sign of being a response at all. */
  isResponse?: boolean;
}): Promise<ReplyMatch | null> {
  const sb = serviceClient();
  const from = input.fromEmail.toLowerCase();
  const domain = from.split("@")[1] ?? "";
  if (!domain) return null;

  const { data: projectRows } = await sb
    .from("projects")
    .select("id")
    .eq("organization_id", input.organizationId);
  const projectIds = ((projectRows as { id: string }[] | null) ?? []).map((p) => p.id);
  if (!projectIds.length) return null;

  // Strongest evidence first: this message names the Message-Id of something
  // we sent. Nothing else can be confused for that.
  for (const ref of input.references ?? []) {
    const { data: threaded } = await sb
      .from("outreach_sends")
      .select("id, project_id, owner_id, prospect_id")
      .in("project_id", projectIds)
      .eq("channel", "email")
      .eq("dry_run", false)
      .eq("provider_message_id", ref.startsWith("<") ? ref : `<${ref}>`)
      .limit(1);
    const hit = ((threaded as Record<string, unknown>[] | null) ?? [])[0];
    if (hit) {
      return {
        projectId: (hit.project_id as string | null) ?? null,
        ownerId: hit.owner_id as string,
        prospectId: (hit.prospect_id as string | null) ?? null,
        sendId: hit.id as string,
      };
    }
  }

  const { data: sendRows } = await sb
    .from("outreach_sends")
    .select("id, project_id, owner_id, prospect_id, recipient, sent_at")
    .in("project_id", projectIds)
    .eq("channel", "email")
    .eq("dry_run", false)
    .ilike("recipient", from)
    .order("sent_at", { ascending: false })
    .limit(1);

  const exact = ((sendRows as Record<string, unknown>[] | null) ?? [])[0];
  if (exact) {
    return {
      projectId: (exact.project_id as string | null) ?? null,
      ownerId: exact.owner_id as string,
      prospectId: (exact.prospect_id as string | null) ?? null,
      sendId: exact.id as string,
    };
  }

  // Nobody at that exact address was written to. Somebody at that company may
  // have been — but only if this looks like a response at all. Without that
  // guard a contacted company's marketing list counts as a reply, which is
  // precisely what happened the first time this ran against a real mailbox.
  if (!input.isResponse) return null;

  const { data: prospectRows } = await sb
    .from("outreach_prospects")
    .select("id, project_id, owner_id, status")
    .in("project_id", projectIds)
    .eq("channel", "email")
    .eq("target_key", domain)
    .in("status", ["contacted", "replied", "won"])
    .limit(1);

  const byDomain = ((prospectRows as Record<string, unknown>[] | null) ?? [])[0];
  if (!byDomain) return null;
  return {
    projectId: (byDomain.project_id as string | null) ?? null,
    ownerId: byDomain.owner_id as string,
    prospectId: byDomain.id as string,
    sendId: null,
  };
}

// ------------------------------------------------------------------ recording

export async function recordReply(input: {
  match: ReplyMatch;
  fromEmail: string;
  subject: string | null;
  snippet: string;
  messageId: string | null;
  receivedAt: Date;
  autoReply: boolean;
}): Promise<"recorded" | "duplicate"> {
  const sb = serviceClient();

  const { error } = await sb.from("outreach_replies").insert({
    project_id: input.match.projectId,
    owner_id: input.match.ownerId,
    prospect_id: input.match.prospectId,
    send_id: input.match.sendId,
    from_email: input.fromEmail,
    subject: input.subject,
    snippet: input.snippet,
    message_id: input.messageId,
    received_at: input.receivedAt.toISOString(),
    auto_reply: input.autoReply,
  });
  // The unique index on (owner_id, message_id) is what makes a re-scan safe,
  // so a conflict here is the expected path rather than a failure.
  if (error) return "duplicate";

  // An auto-reply moves nothing. The prospect has not answered; their mail
  // server has.
  if (!input.autoReply && input.match.prospectId) {
    const { data: current } = await sb
      .from("outreach_prospects")
      .select("status")
      .eq("id", input.match.prospectId)
      .maybeSingle();
    const status = (current as { status?: string } | null)?.status;
    // Never walk an outcome backwards: a prospect already marked won or lost
    // has been judged by a human, and a later reply does not undo that.
    if (status === "contacted") {
      await sb
        .from("outreach_prospects")
        .update({ status: "replied", replied_at: input.receivedAt.toISOString() })
        .eq("id", input.match.prospectId);
    }
  }

  return "recorded";
}

// ------------------------------------------------------------------ scanning

export type ScanResult = {
  mailbox: string;
  scanned: number;
  matched: number;
  autoReplies: number;
  error: string | null;
};

/**
 * Read one mailbox and record anything that answers outreach.
 *
 * imapflow is imported lazily: it opens TLS sockets and is needed only by this
 * path, while everything else importing this module wants the pure helpers
 * above.
 */
export async function scanMailbox(box: ReplyMailbox, now = new Date()): Promise<ScanResult> {
  const result: ScanResult = {
    mailbox: box.fromEmail,
    scanned: 0,
    matched: 0,
    autoReplies: 0,
    error: null,
  };

  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: box.host,
    port: box.port,
    secure: box.secure,
    auth: { user: box.user, pass: box.pass },
    // imapflow logs every command at info level by default, which would put
    // the mailbox password's neighbouring traffic into the app logs.
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = scanSince(box.lastScanAt, now);
      // Search first, then fetch the newest slice. A plain ranged fetch walks
      // the mailbox oldest-first, so on a busy inbox the per-run ceiling is
      // spent on old mail and the scan never reaches the replies it is looking
      // for — which is exactly what a first scan of a real mailbox did.
      const uids = (await client.search({ since }, { uid: true })) || [];
      const recent = uids.slice(-MAX_MESSAGES_PER_SCAN);
      if (!recent.length) {
        result.scanned = 0;
      } else
      for await (const msg of client.fetch(
        recent,
        {
          uid: true,
          envelope: true,
          headers: [
            "auto-submitted",
            "precedence",
            "x-autoreply",
            "x-autorespond",
            "x-auto-response-suppress",
            "list-id",
            "in-reply-to",
          ],
          bodyParts: ["1", "text"],
        },
        { uid: true },
      )) {
        result.scanned += 1;

        const from = addressOf(
          msg.envelope?.from?.[0]?.address ?? msg.envelope?.from?.[0]?.name ?? null,
        );
        if (!from) continue;
        // Our own sent mail, if the account files it in INBOX.
        if (from === box.fromEmail.toLowerCase()) continue;

        const headers = parseHeaders(msg.headers?.toString("utf8") ?? "");
        const subject = msg.envelope?.subject ?? null;
        const auto = isAutoReply({ headers, subject, from });

        const match = await matchReply({
          organizationId: box.organizationId,
          fromEmail: from,
          references: referencedMessageIds(headers),
          isResponse: looksLikeResponse({ headers, subject }),
        });
        if (!match) continue;

        const part = msg.bodyParts?.get("1") ?? msg.bodyParts?.get("text");
        const recorded = await recordReply({
          match,
          fromEmail: from,
          subject,
          snippet: snippetOf(part?.toString("utf8") ?? ""),
          messageId: msg.envelope?.messageId ?? null,
          receivedAt: msg.envelope?.date ?? now,
          autoReply: auto,
        });
        if (recorded === "duplicate") continue;
        if (auto) result.autoReplies += 1;
        else result.matched += 1;
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 300) : "IMAP scan failed";
    try {
      await client.close();
    } catch {
      // Already gone.
    }
  }

  const sb = serviceClient();
  await sb
    .from("organization_outreach_configs")
    // The cursor advances even after an error, deliberately bounded by the
    // day of overlap in scanSince. A mailbox that fails every run would
    // otherwise widen its window forever until the scan times out.
    .update({ last_reply_scan_at: now.toISOString(), reply_scan_error: result.error })
    .eq("id", box.configId);

  return result;
}

/** Every connected mailbox, one after another. */
export async function scanAllMailboxes(now = new Date()): Promise<ScanResult[]> {
  const boxes = await loadReplyMailboxes();
  const out: ScanResult[] = [];
  for (const box of boxes) out.push(await scanMailbox(box, now));
  return out;
}
