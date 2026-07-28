---
openprd: "0.2"
id: "0003"
title: Add Lead Generation to CrawlProof
status: Draft
authors:
  - user@spl00f.com
created: 2026-07-28
updated: 2026-07-28
tags: [lead-gen, growth, outreach, b2b]
---

## Problem

CrawlProof users audit their sites for SEO, AEO, and GEO — but audits only matter if people find them. Most B2B businesses still rely on cold outreach to generate pipeline, yet the existing workflow is fragmented: one tool scrapes directories, another finds emails, a third sends campaigns. Each tool bills separately, CSVs get juggled between them, and shared cold-email IPs torched by bad actors tank deliverability for everyone. There is no unified workflow that goes from "find a company" to "send a grounded email from my own inbox" inside a single dashboard.

## Goals

- Give CrawlProof users a single dashboard to discover, enrich, and contact B2B prospects without leaving the platform.
- Eliminate the need for separate subscriptions to lead scrapers, email finders, and cold-email senders.
- Improve cold-email deliverability by sending from the user's own mailbox (Gmail, Outlook, custom domain) instead of shared IPs.
- Ground every outbound email with context pulled from the scraped source so replies are higher-quality and less spam-like.
- Drive new premium credit consumption and reduce churn by making CrawlProof the hub for both site health and pipeline growth.

## Non-Goals

- We will not become a CRM. Contacts are ephemeral per campaign; long-term pipeline management is out of scope.
- We will not send email from CrawlProof infrastructure. The user's own mailbox is the only sending surface.
- We will not verify or guarantee legal compliance (CAN-SPAM, GDPR, CASL). Compliance guidance may be surfaced as warnings, but responsibility stays with the user.
- We will not purchase or resell third-party lead lists. All data is scraped live from public directories and search results.
- We will not support bulk SMS, LinkedIn InMail, or other channels in the first release.

## Users

**SaaS Founders** — Bootstrapped or early-stage founders who need a repeatable way to find ICP matches from directories like Product Hunt, G2, or niche vertical lists. They have no dedicated SDR and need to do outreach themselves without learning three tools.

**Agency Owners** — Marketing, SEO, or dev-shop owners who prospect from local business directories, Clutch, or industry award lists. They burn 10+ hours a week on manual prospecting and want to automate the top of funnel.

**Freelance DevOps / SEO Consultants** — Solo operators who experience feast-or-famine cycles. They need a lightweight, consistent pipeline builder that does not require a sales tech stack.

**B2B Sales Reps** — Individual contributors at small-to-mid companies whose CRMs are full of stale contacts and whose current tool lands them in Promotions tabs. They want better deliverability and fresher data.

## Requirements

- R1 [P0] Scrape any public directory URL or Google search query and extract company names, domains, and public contact signals.
- R2 [P0] Enrich scraped companies with verified people (name, role) and deliverable email addresses, not generic info@ aliases.
- R3 [P0] Allow the user to connect their own Gmail, Outlook, or SMTP mailbox via OAuth or app-password for sending.
- R4 [P0] Generate grounded cold-email copy from the scraped context (directory description, recent news, role match) rather than generic templates.
- R5 [P0] Send emails through the user's connected mailbox with rate-limiting and per-day caps to protect domain reputation.
- R6 [P1] Provide a campaign dashboard showing: contacts scraped, emails sent, open/reply rates, and bounce rates.
- R7 [P1] Support CSV export of enriched contacts for users who still want to import into an external CRM.
- R8 [P1] Surface deliverability warnings (missing SPF/DKIM, high bounce risk, daily volume exceeded) before a campaign sends.
- R9 [P2] Add an "Unsubscribe" link auto-appended to every outbound email and honor unsubscribes across future campaigns for that mailbox.
- R10 [P2] Allow saved "audiences" (directory + filter rules) so users can re-scrape and re-target without rebuilding the query.

## UX Notes

**Flow: New Campaign**
1. User clicks "New Lead Gen Campaign" in the CrawlProof dashboard.
2. Step 1 — Source: paste a directory URL or enter a Google search query. Preview the first 10 scraped results before committing credits.
3. Step 2 — Enrich: review the people and emails found. User can remove individual contacts or approve the full list. Cost is shown per contact (e.g., 1 credit per enriched contact).
4. Step 3 — Compose: grounded email is auto-drafted from the scrape context. User edits in a plain-text editor. A "Send Test" button fires one email to the user's own address.
5. Step 4 — Send: choose connected mailbox, set daily send cap (default 20), schedule or send now. A confirmation modal warns about compliance and domain health.
6. Post-send: campaign lands on the dashboard with real-time send/reply tracking.

**Mailbox Connection**
- OAuth for Gmail and Outlook is primary. SMTP with app-password is the fallback.
- Connection status is shown as a green/yellow/red badge per mailbox (green = healthy, yellow = recent bounces, red = disconnected or blacklisted).

**Rate Limiting**
- Hard cap of 50 emails/day per mailbox on the first campaign. Cap auto-raises to 100 after 7 days of clean sends (<5% bounce, <0.1% spam complaint). Power users can request manual review for higher limits.

**Grounding**
- The email body is assembled from: company name, role of the recipient, one sentence pulled from the directory/search snippet, and a soft CTA referencing the user's own site (pulled from their CrawlProof project). No merge-field syntax exposed to the user; it reads like natural copy.

## Success Metrics

- 15%+ of landing-page visitors who start a campaign complete the scrape step.
- 80%+ of scraped campaigns yield at least one enriched contact with a verified email.
- 25%+ of enriched campaigns connect a mailbox and send at least one email.
- 8–12% reply rate on sent emails within 14 days.
- 20–30% of replies convert to a booked meeting or demo (self-reported via a post-reply survey).
- Lead Gen becomes a top-3 credit-consuming feature within 90 days of launch.
- Net churn of users who activate Lead Gen is 30% lower than users who do not.

## Risks & Open Questions

- **Legal risk:** Scraping public directories sits in a gray area in some jurisdictions. We need a terms-of-use update and a clear "acceptable sources" policy before launch.
- **Deliverability risk:** Even with rate limits, one user with a burned domain could generate spam complaints that affect CrawlProof's brand. Do we need a domain-health pre-check before allowing send?
- **Email verification accuracy:** Third-party enrichment APIs have false-positive rates. If we bill credits for unverified emails, we risk refund requests. Should we eat the cost of bounces or charge only for "deliverable" grades?
- **Mailbox OAuth scope creep:** Gmail OAuth scopes for sending are sensitive. Will Google's app-verification process block us? Should we start with SMTP-only?
- **Open question:** Should Lead Gen be a separate credit tier (e.g., 2x per credit) because enrichment APIs have hard costs, or fold into the existing credit system?
- **Open question:** Do we build our own scraper or integrate with an existing enrichment API (Apollo, Hunter, Clearbit) and mark up the cost?
