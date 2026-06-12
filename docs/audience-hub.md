# Audience Hub

Centralized, deduplicated, consent-aware contacts across all connected
properties. Hybrid ingest model:

```txt
stats.js            → browser identity, lead capture, attribution (public beacon)
POST /api/events    → trusted account/customer lifecycle (per-project bearer key)
Create PR button    → owner-initiated GitHub install (never silent)
Supabase importer   → optional backfill only (existing org audience feature)
```

## Data model (migration `20260612120000_audience_hub.sql`)

- `audience_contacts` — one row per normalized email per scope. Scope = the
  project's organization when it has one, otherwise the project owner
  (`organization_id` / `owner_id`, enforced by two partial unique indexes).
  Carries lifecycle `status`, `marketing_consent`, unsubscribe/suppression,
  first/last-touch attribution, tags, metadata.
- `audience_identities` — provider/external-id pairs (`project_user`,
  `anonymous`, …) linking visitor ids and app user ids to a contact.
- `audience_project_links` — which properties a contact belongs to (+ plan/role).
- `audience_events` — append-only event log (`browser` | `server` | `import`).
- `audience_consent_events` — explicit consent audit trail (type, value,
  source, hashed IP/UA).
- `project_api_keys` — server ingest keys; sha256(plaintext + SP_TOKEN_PEPPER)
  at rest, plaintext shown once (`cpk_…`, see `lib/audience/projectKeys.ts`).

All tables are RLS select-only for the owning user / org owner; writes go
through the service client inside `lib/audience/hub.ts`.

## Pipeline (`lib/audience/hub.ts`)

`ingestAudienceEvent` implements PRD §17: normalize email → resolve contact
(email, then `project_user`/`anonymous` identity) → create if new → upgrade
lifecycle status (upgrade-only ladder; unsubscribe/suppress/delete are
terminal and override) → first-touch fills holes, last-touch advances →
upsert identities + project link → append event → log explicit consent.

Consent rules: an account email is **never** auto-subscribed. Only explicit
`marketing_consent` booleans (or `newsletter.unsubscribed`) touch consent.
Suppression overrides everything, including later opt-ins.

## Browser API (served by `/stats.js`)

`window.crawlproof` is callable and has methods; calls made before the
script loads can be queued via the standard stub (`window.crawlproof.q`).

```js
crawlproof("identify", { email, name, user_id, marketing_consent: true });
crawlproof("track", "lead.captured", { email, source: "pricing-page" });
crawlproof("consent", { email, marketing_consent: false });
crawlproof("alias", previousAnonymousId);
crawlproof.track("button_click", "cta");   // legacy behavioral form still works
```

Audience payloads ride the existing `/api/track` beacon with UTM params
captured from the page URL. Plain pageviews never enter the audience tables —
only events with an email or in `AUDIENCE_BROWSER_EVENTS`.

## Server API

```http
POST /api/events
Authorization: Bearer cpk_...
Content-Type: application/json

{ "event": "user.created", "email": "user@example.com",
  "user_id": "abc123", "marketing_consent": true,
  "metadata": { "plan": "free" } }
```

Responses: `202` accepted, `400` invalid payload, `401` bad/revoked key,
`429` rate limited (600 events/key/min, in-memory).

## Surfaces

- `/audience` — account-level hub: counts, search, contact table, CSV export
  (`/api/audience/export`, `?consented=1` for marketing-safe export).
- `/audience/[contactId]` — attribution, projects, identities, event
  timeline, consent history.
- `/projects/[id]/audience` — install status, GitHub **Create PR** flow,
  server API keys, manual snippets.

## Create PR flow

`POST /api/projects/[id]/github/create-audience-pr` →
`lib/github/install-audience.ts`. Detects the stack (Next app/pages, Vite,
Hono, Express, static), reuses the tracker installer's snippet
discovery/injection, adds a generated server helper
(`lib/crawlproof/server.ts` or `src/lib/crawlproof.ts`) plus `.env.example`
entries (`CRAWLPROOF_PROJECT_ID`, `CRAWLPROOF_PROJECT_KEY`,
`CRAWLPROOF_INGEST_URL`), and opens a PR on a
`crawlproof/audience-hub-<timestamp>` branch. Runs are audit-logged in
`project_pr_runs` (`kind = 'audience_hub'`).

## Deferred (per PRD MVP cut)

Resend/provider sync, advanced segments, Supabase backfill into the contact
graph, CoinPay DID identities, per-project unsubscribe preferences,
payload-driven email field auto-detection.
