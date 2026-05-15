# Crawlproof Agency Tier — PRD

> Goal: support agencies — one Crawlproof account managing N client sites under a unified dashboard and billing. ~30% of outrank.so's revenue reportedly comes from agencies; the email from Tibo cites a single agency rolling outrank across ~50 client sites as worth $1,500/mo in affiliate commissions. We have the same opportunity if we drop our "one site per user" constraint.
>
> Scoped as a small PRD because the actual work is small: drop one DB constraint, add a site picker, scope a few queries. No new abstractions ("workspaces", "organizations", "teams") in v1 — they all add complexity that solo customers don't need and that agencies can live without.

---

## Status as of 2026-05-15

**Phase 0 — PRD: this document.**

**Phase 1 — Multi-site core: PLANNED (next).**
- Drop `lx_site_user_unique`; users can create multiple `lx_site` rows.
- Add a `current_site_id` cookie + a site-picker dropdown in the app nav.
- Scope the existing autoblog setup / dashboard / history / article-detail routes to the active site.
- Same for `/social/*` once Social Posting Phase 1 ships (PRD §3 of social-posting-prd.md updates `sp_account` to be site-scoped).

**Phase 2 — Agency dashboard: PLANNED.**
- A `/agency` route that shows all sites at a glance: per-site article count, publish health, credit burn, last activity.
- Bulk operations: pause/resume all sites, export an agency-wide report.

**Phase 3 — Client handoff: PLANNED.**
- Transfer a site (and its history) from an agency's account to a separate client account. The agency stops being billed for it; the client picks up.
- Useful when agencies "graduate" clients off the agency plan.

**Phase 4 — Workspace abstraction: PUNTED.**
- The fancy version: organizations / workspaces / role-based team invites. Adds an entire RBAC layer we don't need today. Revisit only if a real customer asks for "let our intern manage site X but not site Y." Until then, all sites under one user.

**Affiliate program: SEPARATE PRD.**
- The 30%-lifetime piece from outrank's pitch is its own doc (Stripe payouts, referral attribution, /affiliate dashboard). Cross-references the agency tier but ships independently.

---

## 1. Competitive recon — how outrank.so handles agencies

(Already partially captured in `docs/link-exchange-prd.md` §1.2 from the 2026-05-13 reverse-engineering session.)

- Outrank's tenancy: `organizations 1─* users` and `organizations 1─* products`. The "product" = one customer site. Agencies create many products under one organization.
- The active product is selected via a `current_product_id` cookie. Switching products in the UI just rewrites that cookie.
- Per-product credit balance. Each product (= site) has its own `monthly_backlink_credits` and renewal date.
- Per-product billing: outrank charges $89–99/mo *per product*. Agency with 50 clients = 50 line items.

**What we copy:** the `current_site_id` cookie, the per-site grouping for dashboards.

**What we change:**
- Single billing rollup, not per-site. Agencies want one invoice, not 50. The credit ledger stays per-user; sites consume from the same balance.
- No organizations table. The agency *is* the user. Until someone asks for team invites, we don't need RBAC.

---

## 2. Schema changes

Minimal. The autoblog v1 migration already documented this transition:

```sql
-- supabase/migrations/v1: "v1: one site per user. Drop this unique
-- index to enable multi-site later."
create unique index if not exists lx_site_user_unique on public.lx_site(user_id);
```

This migration drops it and adds a name field so the picker can show something meaningful:

```sql
-- Drop the v1 constraint that prevented multi-site agencies.
drop index if exists public.lx_site_user_unique;

-- A human-readable name shown in the site picker. Defaults to the
-- domain. Agency can rename ("Acme client" vs. acme-corp.com).
alter table public.lx_site
  add column if not exists name text;

-- Backfill: existing rows take domain as the name.
update public.lx_site set name = domain where name is null;
```

That's it for Phase 1. Domain uniqueness (`lx_site_domain_unique`) stays — a single domain can't be enrolled twice across the whole network, agency or not.

### 2.1 What about `sp_account` (Social Posting)?

Updates `docs/social-posting-prd.md` §3:

```sql
create table sp_account (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  site_id uuid not null references public.lx_site(id) on delete cascade,
  --                          ^^ NEW
  ...
);
create unique index on sp_account(site_id, platform, external_id);
```

Each connected social account belongs to a *site* (agency: a client). The agency operator's `user_id` is on the row for RLS, but the natural grouping is `site_id`.

### 2.2 Per-site rollup queries (the agency dashboard)

The agency dashboard is just one query per stat:

```sql
-- Articles published this month, grouped by site.
select s.id, s.name, s.domain, count(a.id) as published_this_month
from lx_site s
left join lx_article a
  on a.site_id = s.id
  and a.status = 'published'
  and a.published_at >= date_trunc('month', now())
where s.user_id = $1
group by s.id;
```

No joins across users, no permission gymnastics. Just `where user_id = $1`.

---

## 3. UI surface changes

### 3.1 Site picker

Lives in the app nav (`app/(app)/layout.tsx`), to the left of the credits badge. A dropdown showing all the user's sites. Selecting one writes `current_site_id` to a cookie and refreshes.

For single-site users it's a no-op (one row shown). For agencies, it's the navigation primitive that turns 50 client sites from chaos into a list.

```tsx
<SitePicker
  sites={sites}
  current={currentSiteId}
  onChange={(id) => { document.cookie = `current_site_id=${id}; path=/`; router.refresh(); }}
/>
```

### 3.2 Site-scoped routes

These routes all currently fetch the user's single site. Update each to read `current_site_id` from cookie and fetch *that* site (with a 404 + redirect fallback if the cookie's stale):

- `/autoblog` (dashboard)
- `/autoblog/setup` (form)
- `/autoblog/history` (article list)
- `/autoblog/articles/[id]` (detail) — already site-scoped via the article row; just need to confirm RLS keeps it that way

Server-side helper: `lib/lx/currentSite.ts` — given the cookie + user, return the active site or null.

### 3.3 New site creation

`/autoblog/setup` becomes "create / edit one of your sites." The discover wizard from the URL-onboarding flow runs on each new site. Existing setup flow works unchanged for the *current* site; adding a "+ New site" button in the picker lets users start a fresh wizard.

### 3.4 Agency dashboard (Phase 2)

`/agency` — only shown when the user has ≥2 sites (single-site users don't need it). Layout:

- Top row: aggregate stats (sites managed, articles published this month, credit burn this month).
- Table of sites, one row each: name, domain, status badge, articles-this-month, last article date, credit balance row showing credits consumed.
- Per-row actions: pause, view dashboard, edit settings, transfer (Phase 3).

---

## 4. Per-feature impact

Walking the existing features to confirm what each needs.

| Feature | Today | After multi-site |
|---|---|---|
| Autoblog dashboard | one site per user | site picker; selected site's stats |
| Autoblog setup wizard | edits the user's site | edits the *current* site; "+ New site" creates another |
| Autoblog article history | the user's articles | current site's articles |
| Webhook delivery | uses `lx_site.webhook_url` | unchanged — each site has its own webhook |
| Perf-report email | aggregates across the user's audits + autoblog | aggregates across **all sites** for that user; agency emails contain N sub-sections |
| Social posting (when it lands) | site-scoped from day one (see §2.1) | — |
| Link exchange (when it lands) | per-site toggle (`backlinks_enabled`) | per-site toggle, agency can flip it on for some sites and not others |
| Credit ledger | per-user | per-user (no change); agency just sees one balance funding all sites |

---

## 5. Pricing model

**One credit balance per user, shared across all their sites.** No per-site billing.

Why: agencies want one invoice. Credits are fungible — a credit that would have been spent on Site A's article can be spent on Site B's article. Simpler ops, less customer support friction.

Stripe / billing impact: zero. The existing credit packs (Starter $9 / Growth $25 / Pro $99) work unchanged. A heavier-usage customer (50-site agency publishing daily) burns through Pro every ~2 weeks instead of every 9 months; they top up more often.

### 5.1 Pricing the agency tier (later)

When the affiliate PRD lands, we'll likely want an **agency tier** with discounted credits at volume (e.g. 5000 credits for $349 = $0.07/credit vs. the $0.20/credit Pro pack rate). That's a pricing move, not a schema move; deferred.

---

## 6. Migration plan (zero downtime)

1. Run the SQL migration during the next deploy. Drops the unique index, adds the `name` column, backfills.
2. Ship the site-picker UI in the same deploy. Single-site users see a one-item dropdown they can ignore.
3. The `current_site_id` cookie defaults to the user's first (and only) site for existing users.
4. Add the "+ New site" button.

No data migration of articles, integrations, keywords needed — all those tables already reference `lx_site.id`, not `user_id`. Multi-site just means the user can now own multiple rows in `lx_site`.

---

## 7. Risks

- **Stale `current_site_id` cookie after delete.** If an agency deletes a site, any tab still holding that cookie 404s. Server-side helper falls back to the user's first site and rewrites the cookie. Handled in `currentSite.ts`.
- **Cross-site data leaks via misscoped queries.** Every route that fetches site data needs `where site_id = $current AND user_id = $auth_uid`. Easy to forget the `user_id` half. Mitigation: a `getCurrentSiteOrThrow()` helper that always joins on both, used by every route handler.
- **Articles attributed to the wrong site after a webhook URL collision.** Mitigation: `lx_site.webhook_secret` is per-site; the receiver's incoming bearer is what disambiguates which site published. Already enforced.

---

## 8. Build sequence

1. **Migration** — drop unique index + add `name`. New file `20260516000000_lx_site_multi.sql`.
2. **`currentSite.ts` helper** — reads cookie, validates ownership, returns the row or redirects.
3. **Site picker** in `app/(app)/layout.tsx`.
4. **Refactor autoblog routes** — `/autoblog`, `/autoblog/setup`, `/autoblog/history`, `/autoblog/articles/[id]` — to use the helper.
5. **"+ New site" flow** — clicking it routes to `/autoblog/setup?new=1` which forces the discover wizard.
6. **Agency dashboard** (Phase 2) — `/agency` route, only renders for users with `count(sites) >= 2`.
7. **Client handoff** (Phase 3) — `/agency/transfer/[siteId]` form. Generates a transfer code; recipient claims via `/transfer/claim/[code]`.

---

## 9. Open questions for before build

- **Name field default.** "acme-corp.com" is a fine technical default; agencies will probably want "Acme Corp" without the TLD. Worth a `lib/lx/domainName.ts` heuristic (strip TLD, title-case)?
- **Site limits.** Should we cap free-tier accounts to 1 site to prevent agency-on-a-free-plan? Yes — but enforce it as a server-side check at site-create time, not a UI hide.
- **"+ New site" credit cost.** Free to create, or 1 credit? Outrank charges $89-99/mo *per product*. We charge per-article. Probably free to create; the credit cost shows up when articles publish.
- **Per-site team invites (deferred to Phase 4).** Worth even mentioning in marketing copy? Agencies might assume it works.

---

## 10. Out of scope for v1

- Organizations / workspaces / teams (Phase 4 punt)
- Role-based access (only `is_admin` exists today, app-wide)
- Per-site billing / per-site invoices
- Per-site Stripe customers
- Sub-user invites ("our intern manages site X")
- Hierarchical site groups ("Acme has 3 sub-brands")
- White-label / co-branded agency dashboards
- Bulk import of sites from a CSV
- API access ("hit our API to provision a site programmatically") — agencies want this, separate small PRD when it surfaces

---

## 11. Dependencies on other PRDs

- **Autoblog (`docs/link-exchange-prd.md`)** — shipped. The site-picker scoping touches every autoblog route; this PRD is what unlocks Autoblog for agencies.
- **Social Posting (`docs/social-posting-prd.md`)** — PRD'd, Phase 1 about to start. Affected: `sp_account` schema needs `site_id`. Updated in §2.1 of this PRD; will also update the social-posting PRD's §3 in the same commit that lands this PRD.
- **Viral Video (`docs/viral-video-prd.md`)** — PRD'd, not yet built. Affected: `vid_job.site_id` already exists in that PRD's schema. No change needed.
- **Affiliate program (TBD)** — separate PRD when ready. Will reference this one for the "agencies onboard many sites" growth story.
