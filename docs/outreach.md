# Leads — automated lead generation & cold outreach

Find businesses that need what CrawlProof sells, scan their sites, write a
cold email that cites what the scan actually found, and send it — on a
schedule, without anyone in the loop.

**Leads are project-scoped.** They live at `/projects/[id]/leads` (the
"Leads" tab), and every MCP tool takes a `project`. The same agency runs
different outreach for different clients, and the pitch is made on behalf of
one of them. The send caps stay per *person*, though — one operator with five
projects still has one sending reputation.

Two paid MCP servers were the starting point. Neither is the design.

| | Velvet Forge (`velvetgeaux/velvet-forge`) | Signal Found (`signal-found/sf-mcp`) | This |
|---|---|---|---|
| What it is | 7 LLM prompt wrappers behind an API key | HTTP client for a hosted Reddit DM platform | Toolset + autopilot on CrawlProof's own scanner |
| Personalisation | business name + industry into a prompt | product description into their backend | findings from a real scan of the prospect's site |
| Lead source | none — you bring the list | their "proprietary Reddit network" | search engines, directory pages, your own scans |
| Reddit auth | n/a | Chrome extension replaying your session, or a farm of hundreds of accounts | official OAuth API, your own account |
| Volume model | per-seat subscription | "thousands of DMs a day", credits per message | small daily caps, dry-run by default |
| Cost | $397–$997/mo tiers | credits per message | free engines by default; ValueSERP when configured |

Velvet Forge's `build_pitch` never looks at the prospect's website — the
"personalisation" is a merge field. Signal Found's volume model is against
Reddit's User Agreement and ends with the accounts suspended and the domain
blocked sitewide. What survives is narrower and works better: open with a
specific defect on their actual site, linked to a report they can check.

## The funnel

```
discover → scan → research → draft → send → follow up (step 2, then 3)
```

Each stage is idempotent and resumable, because the unattended runner
re-enters mid-funnel on every tick.

- **discover** — ValueSERP when `VALUESERP_API_KEY` is set, otherwise the free
  engines (DuckDuckGo → Mojeek); plus directory/listicle pages whose outbound
  links are candidates. Platforms and aggregators (Yelp, Facebook, G2, …) are
  filtered out, or every campaign's top "prospects" are the same six sites.
- **scan** — free engines only (`rule`, `dns`). An unattended campaign that
  spent credits per discovered domain would burn a balance on prospects that
  turn out to be unreachable.
- **research** — findings, score, a fix quote from `lib/audit/quote.ts`, and
  the contact address the business publishes on its own pages.
- **draft** — grounded generation, then a validation pass that rejects the
  model's own output if it cites a score or report that doesn't exist, or
  implies a prior relationship.
- **send** — one code path (`sendProspectEmail`), with every check inside it
  so a new caller cannot forget them.
- **follow up** — step 2 after 4 days, step 3 after another 7. Each step is a
  different job; step 2 must add new information, step 3 closes the loop and
  says so.

## The UI

`/projects/[id]/leads` — the Leads tab on any project.

- **Find leads** — a search query, or a directory page whose outbound links
  become candidates. Each new domain gets a free scan queued immediately.
- **Campaigns** — the autopilot. Create one with sources and caps; it starts
  in drafts-only mode. "Run now" ticks it by hand; "Enable sending" is a
  deliberate second act, and is disabled entirely until the postal address is
  configured.
- **Pipeline** — every lead with its score, contact, top findings, fix quote
  and report link. Per-lead: *Rescan*, *Draft email*, *Never contact*.
- **Sending is two clicks.** *Test (dry run)* runs the entire path —
  suppression checks, grounding checks, the CAN-SPAM footer — without mailing
  anyone. Only after it passes does *Send for real* appear. Edited draft text
  is re-checked against the scan, so hand-typing a claim the report doesn't
  support is refused too.

## Tools

Mounted on the existing MCP server at `https://crawlproof.com/api/mcp`
(`Authorization: Bearer crp_…`). Seven tools, one per verb — the channel
(email or Reddit) is a parameter, not a separate tool. Each takes an optional
`project` (id, name, or site URL) and defaults to the only project when there
is just one.

| Tool | What it does |
|---|---|
| `find_leads` | `source: search` businesses by query · `reddit` threads worth answering · `scans` weak sites already in your own scans |
| `research_lead` | Scan the site, price the fix, find the published contact. `contact_only` skips the scan; `person` guesses an address with SMTP verification |
| `draft_message` | Grounded draft — from the scan (email) or from what they asked (Reddit) |
| `send_message` | The only tool that contacts anyone. **Dry run unless `dry_run: false`** |
| `campaign` | `create` / `update` / `run` / `list`. `{action:'update', name, active:false}` is the kill switch |
| `leads` | Pipeline summary, or `format: csv \| json` to export |
| `suppress` | Do-not-contact: an address, a whole domain, or a Reddit user |

## Guardrails

These are the design, not a safety bolt-on. Cold outreach that ignores them
costs a sending domain, and a domain does not come back.

- **Dry run by default** everywhere that touches the outside world.
- **`auto_send` defaults false.** A new campaign discovers, scans, researches
  and drafts on its own, logging each message as a dry run. Read a few, then
  enable sending deliberately.
- **Global do-not-contact list** (`outreach_suppressions`), scoped to an
  address, a whole domain, or a Reddit user. Global on purpose: an opt-out is
  a promise CrawlProof makes, not one that a single user makes.
- **One-click unsubscribe** in every cold email, plus `List-Unsubscribe`
  headers, with a second link that covers everyone at the domain. Cold
  prospects get their own token — enrolling them in `marketing_contacts` to
  give them an unsubscribe link would subscribe them to the newsletter.
- **CAN-SPAM postal address.** `OUTREACH_POSTAL_ADDRESS` is required for live
  sending; without it, sends are refused and dry runs still work.
- **Grounding checks.** A draft citing a score the report doesn't have, or
  opening with "great speaking with you", is rejected before it can be sent.
- **Sites that score well are skipped.** Pitching a rescue at a site that
  doesn't need one reads as a mailshot that didn't look at its own data.
- **Never contacted:** machine mailboxes (noreply, postmaster, abuse, legal,
  security), our own domains, anyone who unsubscribed from any CrawlProof
  mail, and anyone already contacted at that step.
- **Reddit:** the subreddit's live rules are read before posting and a
  no-promotion rule is a hard stop; public replies preferred; one cold DM per
  person ever; replies must disclose ownership, must not lead with our link,
  and must not read as a pitch.

## Setup

1. **Migration** — `supabase/migrations/20260726160000_cold_outreach.sql`
   (`outreach_prospects`, `outreach_sends`, `outreach_suppressions`,
   `outreach_campaigns`; prospects and campaigns are keyed on `project_id`).
   Not yet applied to production. No RLS policies: the page and the tools
   both read through the service client after `requireProjectAccess`, which
   is how the rest of the project pages work and keeps `outreach_sends`
   unwritable from a browser.

2. **Env**

   ```
   OUTREACH_POSTAL_ADDRESS="Profullstack, Inc., <street>, <city> <zip>"  # required to send
   OUTREACH_DAILY_CAP=50                 # live emails per user per rolling 24h
   REDDIT_OUTREACH_DAILY_CAP=10          # Reddit actions per user per 24h
   REDDIT_OUTREACH_SUBREDDIT_CAP=3       # per subreddit per 24h
   VALUESERP_API_KEY=…                   # optional; better discovery than the free engines
   ```

3. **Cron** — `POST /api/cron/outreach` with `x-cron-secret`, every 15
   minutes. Ticking faster doesn't help: the slow step is the scan worker and
   the daily caps are the real throttle.

4. **Reddit** — reconnect the account at Settings → Social. The OAuth scopes
   grew (`read`, `privatemessages`); connections made before that get a 403
   and the tools say so.

## Notes from testing

- **DuckDuckGo's HTML endpoint answers HTTP 202** (anti-bot challenge) from
  datacentre IPs. **Mojeek serves the first query from an IP and then 403s.**
  Free search is genuinely best-effort from a server — set
  `VALUESERP_API_KEY` if discovery needs to be reliable. Seed-URL discovery
  has no such dependency and works consistently.
- **SMTP verification in `email_find`** is honest about its limits: most
  cloud hosts block outbound port 25, and large providers accept every
  address. Those cases return `unverified` rather than a guess presented as a
  fact. It never sends a message — the session is aborted before `DATA`.
