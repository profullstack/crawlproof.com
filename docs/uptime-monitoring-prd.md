# CrawlProof Uptime Monitoring & Alerts — PRD

> Goal: add uptime/availability monitoring to CrawlProof so a project owner is
> alerted the moment a monitored site, API, or host goes offline — and again when
> it recovers. This extends CrawlProof from "see your site the way AI crawlers do"
> into "and know instantly when it stops responding at all."
>
> Positioning basis: [Hesklo](https://www.hesklo.com/) (visual on-call + uptime),
> UptimeRobot, Better Uptime, Pingdom. Our wedge is a generous free tier bundled
> into a tool CrawlProof users already run against their sites.
>
> **Headline offer: free for up to 20 monitors (alerts), forever.**

---

## Status as of 2026-07-05

**Phase 0 — PRD: this document.**

**Already in CrawlProof (reused, not rebuilt):**
- Single Railway service running Next.js (`server.js`) + worker (`worker/index.ts`)
  via `start.sh`; Next enqueues jobs to the worker over in-container loopback.
- Worker job loop with Supabase service-role client, already running scheduled
  work (scan runs, `processDueSocialFeeds`, LX article gen, stuck-job repair).
- Email delivery via Resend + existing HTML email templates (`lib/email`).
- Existing **ValueSERP email-alerts** feature (rank-change alerts) — same
  "detect change → notify" shape; uptime alerts reuse its notification plumbing.
- Org / project / membership model with RLS, project API keys, webhook delivery.
- Supabase migrations (timestamp-prefixed) applied via CLI.

**New for this PRD:**
- Scheduled availability checks (HTTP/TCP/PING/keyword/SSL) with a due-time loop.
- Up/down state machine with multi-failure confirmation and recovery detection.
- Incident records + per-project public status page.
- Multi-channel alerts (email, webhook, Slack, Discord; SMS later).
- Free/paid monitor limits (20 free).

---

## 1. Product Positioning

CrawlProof today answers "is my site *optimized* for search and AI crawlers?"
Uptime monitoring answers the more urgent question underneath it: "is my site
*up at all*?" Bundling the two means a CrawlProof project already knows the URLs
worth watching — a user adds uptime monitoring in one click from a project they
already have.

> **Pitch:** Know before your customers do. 20 uptime monitors free — alerts to
> email, Slack, Discord, and webhooks, with a public status page.

Versus Hesklo (which leads with a visual on-call escalation canvas), we lead with
**zero-config setup + a high free-tier limit inside a tool users already run**.
On-call escalation is explicitly a later phase.

---

## 2. Objectives

### 2.1 Primary Goals
- Detect downtime for HTTP(S), TCP, PING, keyword, and SSL-expiry checks.
- Alert within one confirmed check cycle across multiple channels; alert on recovery.
- Free tier of **20 monitors** at 60s interval, no credit card.
- Public status page per project (uptime %, response times, incidents).
- Near-zero idle cost: no new always-on service — reuse the existing worker.

### 2.2 Non-Goals (V1)
- Visual on-call escalation policies / rotations (Hesklo's core) — Phase 2.
- Multi-region probing — single region at launch.
- Synthetic multi-step browser journeys (Playwright flows) — Phase 2.
- APM / tracing / log ingestion.

### 2.3 Success Metrics
- Time-to-first-monitor < 60s from an existing project.
- False-positive alert rate < 2% (multi-failure confirmation).
- Down-alert delivery latency < 30s from confirmed failure.
- ≥ X% of active projects add ≥ 1 uptime monitor within 30 days (target TBD).

---

## 3. Monitor Types (V1)

| Type | Checks | Config |
|---|---|---|
| **HTTP(S)** | Status code, response time, redirect handling | URL, expected status, timeout, follow-redirects |
| **Keyword** | HTTP body contains / omits a string | URL, keyword, match mode |
| **SSL expiry** | Cert days-to-expiry warning | Host, warn-days (default 14) |
| **TCP** | Port open | Host, port |
| **PING (ICMP)** | Host reachability | Host / IP |

Each monitor: name, type, target, interval (60s free / 30s paid), timeout,
expected-result config, channel(s), enabled flag, and optional link to the
CrawlProof project it belongs to (so the site URL prefills).

---

## 4. Alerting Logic

### 4.1 State machine
`UP → (n consecutive failures) → DOWN → (m consecutive successes) → UP`

- **Multi-failure confirmation:** default 2 consecutive fails before `DOWN`
  (kills transient blips / flapping).
- **Recovery:** default 1 success before `UP`.
- `UP→DOWN` → send **down alert** to all channels; open an incident.
- `DOWN→UP` → send **recovery alert** with downtime duration; close the incident.

### 4.2 Anti-noise controls
- **Cooldown / flap dampening:** minimum re-alert interval per monitor.
- **Maintenance windows:** suppress alerts during scheduled windows.
- **Schedule gates (V1.1):** restrict noisy channels to business hours.

### 4.3 Incident record
Each `DOWN` opens an incident (`started_at`, cause snapshot: status code / error /
response time). Recovery closes it (`ended_at`, `duration_s`). Incidents drive the
status page and rolling uptime %.

---

## 5. Notification Channels

- **V1:** Email (Resend, reuse `lib/email`), Webhook (reuse project webhook
  delivery + SSRF guard), Slack, Discord.
- **V1.1:** SMS via Twilio, Telegram.
- **Phase 2:** PagerDuty, Teams, Jira (auto-resolve on recovery).

Each channel is verified on creation with a test send. Alert payload: monitor
name, type, target, new state, error detail, timestamp, and (on recovery)
downtime duration.

> SMS follows the `qryptchat` pattern: app-env Twilio creds with **hard
> cost-protection caps**, never an open relay.

---

## 6. Plans & Limits

| | **Free** | **Pro** | **Team** |
|---|---|---|---|
| Monitors (alerts) | **20** | 100 | 500 |
| Min interval | 60s | 30s | 30s |
| Channels | Email, Webhook, Slack, Discord | + SMS, Telegram | All |
| SMS credits | — | 100/mo | 500/mo |
| Status pages | 1 (crawlproof subdomain) | 3 + custom domain | Unlimited + custom domain |
| Result retention | 30 days | 90 days | 1 year |

Over-limit monitors are **disabled, not deleted**, with an upgrade prompt.
Where CrawlProof already has plan tiers, fold uptime limits into the existing
plan model rather than inventing a parallel one.

---

## 7. Public Status Page

- Per-project page (crawlproof subdomain; custom domain on paid).
- Current status per monitor, rolling 90-day uptime %, response-time chart, and
  open/recent incidents.
- Optional incident subscribers (email on open/close), reusing Resend.

---

## 8. Architecture

Reuses the existing single-service topology — **no new always-on process.**

### 8.1 Scheduling in the existing worker
- Add a due-time sweep to `worker/index.ts`'s loop (alongside scan runs and
  `processDueSocialFeeds`): `SELECT ... FROM monitors WHERE enabled AND due_at <= now()
  FOR UPDATE SKIP LOCKED`, run the check, evaluate the state machine, write the
  result/incident, enqueue notifications, then set `due_at = now() + interval_s`.
- Bounded concurrency + per-target timeout so the sweep stays within the loop budget.
- Single region V1 (add a `region` column later for fan-out).

### 8.2 Data model (new tables, timestamp-prefixed migration)
- `monitors` (id, org_id, project_id?, name, type, target, config jsonb,
  interval_s, timeout_s, fail_threshold, recover_threshold, enabled,
  current_state, due_at, last_checked_at)
- `check_results` (monitor_id, checked_at, ok, status_code, response_ms, error) — pruned by retention
- `incidents` (monitor_id, started_at, ended_at, cause, duration_s)
- `notification_channels` (org_id, type, config jsonb, verified_at)
- `monitor_channels` (monitor_id, channel_id)
- `maintenance_windows` (scope, starts_at, ends_at, rrule?)
- `uptime_status_pages` (org_id/project_id, slug, custom_domain, config)

All RLS-scoped to org/project, consistent with existing tables.

### 8.3 UI (Next.js)
- "Uptime" section within a project + an org-level monitors list.
- Add-monitor modal (prefills project URL), channel setup, incident timeline,
  status-page settings.

### 8.4 Deployment / migration note
- No Railway topology change — same service, same `start.sh`.
- **From the crawlproof migration lesson:** prod Supabase migration history has
  diverged, so `supabase db push` is blocked — apply the new migration as a
  **single migration via psql over the pooler**, not `db push`.

---

## 9. Cost Protection

- Global + per-org daily SMS caps; disable channel on cap breach and notify owner.
- Server-side min-interval enforcement (free can't set sub-60s).
- Outbound webhook + HTTP-check SSRF guard: block internal/link-local/metadata
  IP ranges; enforce timeouts and total sweep budget to prevent runaway concurrency.

---

## 10. Milestones

| Milestone | Scope |
|---|---|
| **M1 — Core loop** | HTTP + keyword + SSL monitors, due-time sweep in worker, state machine, email + webhook alerts, monitor CRUD UI |
| **M2 — Channels + status page** | Slack, Discord, public status page, incident history, uptime % |
| **M3 — Plans + limits** | Fold into existing plan tiers, 20-free enforcement, SMS (Twilio) + caps, custom domains |
| **M4 — Polish** | TCP/PING checks, maintenance windows, schedule gates, weekly summary email |
| **Phase 2** | On-call escalation policies, multi-region probing, PagerDuty/Teams/Jira, Playwright journeys, **exposed-services / port-drift check (§12)** |

---

## 11. Open Questions

1. "20 alerts" = **20 monitors** (assumed) or 20 notification *events*/month? Confirm.
2. Are uptime monitors org-scoped, project-scoped, or both? (PRD assumes both:
   optional `project_id`, counts against org limit.)
3. Fold into existing CrawlProof plans, or introduce an uptime add-on SKU?
4. Status page: reuse existing public-report subdomain scheme, or new namespace?
5. Do TCP/PING (ICMP) checks work from the Railway runtime, or do they need an
   external prober? (May push PING to Phase 2.)

---

## 12. Phase 2 — Exposed-Services / Port-Drift Check

A lightweight attack-surface monitor: on a verified-owned host, detect ports that
are open to the public internet but *shouldn't* be — e.g. a Redis (6379) or
Postgres (5432) accidentally exposed. Framed as **security drift detection**, not
a scanner.

> **Value framing:** "You told us to watch 80/443. We now also see **6379 (Redis)**
> reachable from the public internet on your verified host — likely a
> misconfiguration." Alerts fire when the open-port set *changes* from an accepted
> baseline, not merely because a port is open.

### 12.1 Hard constraints (why this is Phase 2, not V1)
- **Owned targets only.** Reuse CrawlProof's existing **domain-ownership
  verification** as the gate. No arbitrary hostnames — this must never become
  port-scanning-as-a-service against third parties.
- **Not from the Railway app IP.** Run scans from an **external prober / port-check
  API**, so an egress-abuse flag can't take down production. GCP and Railway AUPs
  prohibit network scanning; scanning from the app IP risks the service's IP.
- **Bounded + TCP-connect only.** Curated **top-~100 common service ports**, never
  full 65535; TCP `connect()` only (containers lack `CAP_NET_RAW` for SYN scans
  anyway); ICMP discovery skipped (`-Pn`-equivalent).
- **Rate-limited + infrequent.** Daily cadence, not per-minute; per-org caps.

### 12.2 Behavior
- Establish a **baseline** open-port set per host on first scan (user confirms
  "these are expected").
- On each subsequent scan, diff against baseline. **New open port → alert**
  (down-alert-style, same channels). Closed expected port → optional info alert.
- Record findings as incidents/events so they show in history and (optionally) a
  private security view — **not** the public status page by default.

### 12.3 Open items
- Build vs. buy the prober: a dedicated small non-Railway box vs. an external
  port-scan API. Leaning external API to sidestep AUP + IP-reputation risk.
- Which port list ships as the default "watch" set.
- Whether findings feed CrawlProof's existing audit/finding surface or a new one.
