# PRD: CrawlProof - PostHog Bidirectional Webhook Integration

Product: CrawlProof.com
Owner: Profullstack, Inc.
Status: Draft
Version: 1.0.0
Date: 2026-06-06

## Summary

CrawlProof should support a bidirectional PostHog integration:

- CrawlProof -> PostHog: send product, crawler, bot-detection, link-exchange, billing, and customer lifecycle events into PostHog for analytics, funnels, dashboards, alerts, cohorts, and workflows.
- PostHog -> CrawlProof: accept verified webhook calls from PostHog workflows so analytics conditions can update CrawlProof state or notify internal systems.

The V1 recommendation is internal-first: CrawlProof sends key events to Profullstack's PostHog project and exposes one inbound webhook endpoint for internal PostHog workflows. Customer-owned PostHog projects come after the internal event taxonomy stabilizes.

## Goals

- Add a first-class PostHog integration surface in CrawlProof settings.
- Send CrawlProof events into PostHog server-side.
- Allow PostHog to call CrawlProof webhook endpoints for automation.
- Provide event mapping for product analytics, bot analytics, billing analytics, and link-exchange analytics.
- Support safe retry, idempotency, signing or shared-secret verification, and audit logging.
- Make the integration usable internally first, then extensible to customer-owned PostHog projects and future webhook destinations.

## Non-Goals

- Do not replace CrawlProof's primary database with PostHog.
- Do not send raw sensitive request bodies to PostHog by default.
- Do not expose privileged Supabase service-role keys or PostHog keys to the browser.
- Do not rely on client-side analytics for billing, security, enforcement, or abuse decisions.
- Do not block crawler detection or app flows if PostHog is unavailable.

## Users

- CrawlProof Admin: needs product usage, crawler volume, abuse, revenue, and activation analytics.
- CrawlProof Customer: wants visibility into bots, AI crawlers, script installation, and CrawlProof actions.
- Customer Developer: needs clear docs and API examples for forwarding CrawlProof events to analytics.
- Growth / Marketing Operator: wants workflows for signup, install, activation, high-intent leads, support follow-up, and lifecycle campaigns.

## Feature Overview

### Outbound: CrawlProof Calls PostHog

CrawlProof sends server-side events such as:

- `account_created`
- `org_created`
- `domain_connected`
- `dns_verified`
- `script_installed`
- `crawler_detected`
- `ai_bot_detected`
- `bot_blocked`
- `bot_allowed`
- `rule_created`
- `rule_matched`
- `link_exchange_offer_created`
- `link_exchange_match_found`
- `credit_earned`
- `credit_spent`
- `checkout_started`
- `plan_upgraded`
- `invoice_paid`
- `integration_connected`

Preferred implementation:

- Use PostHog Capture API or server-side SDK for CrawlProof-owned analytics.
- Write outbound events to an `event_outbox` table first.
- Deliver asynchronously so PostHog downtime does not break app UX.
- Keep sanitized payload previews in audit logs.

### Inbound: PostHog Calls CrawlProof

PostHog workflows can call:

```txt
POST /api/integrations/posthog/webhook
```

Supported V1 actions:

- `capture_internal_event`
- `tag_user`
- `create_alert`
- `update_org_property`

Allowed tags:

- `activated`
- `high_intent`
- `needs_support`
- `billing_risk`
- `enterprise_candidate`

Allowed org properties:

- `posthog_lifecycle_stage`
- `activation_state`
- `risk_score`
- `last_posthog_workflow_at`

## Event Taxonomy

Every outbound event should include:

```json
{
  "distinct_id": "user_or_org_scoped_id",
  "user_id": "uuid | null",
  "org_id": "uuid",
  "domain_id": "uuid | null",
  "domain": "example.com | null",
  "plan": "free | pro | business | enterprise",
  "source": "crawlproof",
  "environment": "production | staging | development"
}
```

Bot and crawler events should avoid raw identifiers by default:

```json
{
  "event": "crawler_detected",
  "properties": {
    "crawler_name": "Googlebot",
    "crawler_category": "search_engine | ai_agent | seo_tool | scraper | unknown",
    "user_agent_hash": "sha256_hash",
    "ip_hash": "sha256_hash",
    "path": "/pricing",
    "method": "GET",
    "country": "US",
    "asn": "AS15169",
    "confidence": 0.96,
    "action": "allow | block | challenge | observe"
  }
}
```

Billing events must be server-side only and must never trust client-submitted payment data.

## Inbound Webhook Contract

Headers:

```txt
Content-Type: application/json
X-CrawlProof-Webhook-Secret: <shared secret>
X-PostHog-Workflow-Id: <optional workflow id>
X-Idempotency-Key: <recommended unique id>
```

Payload:

```json
{
  "action": "tag_user | create_alert | update_org_property | capture_internal_event",
  "event": "posthog_workflow_triggered",
  "idempotency_key": "workflow-run-id-or-uuid",
  "actor": {
    "type": "posthog",
    "workflow_id": "string",
    "project_id": "string"
  },
  "target": {
    "user_id": "uuid",
    "org_id": "uuid",
    "domain_id": "uuid"
  },
  "properties": {
    "tag": "activated",
    "reason": "completed_activation_funnel"
  }
}
```

Response:

```json
{
  "ok": true,
  "status": "accepted",
  "webhook_event_id": "uuid"
}
```

Future v1.1 headers:

```txt
X-CrawlProof-Signature: sha256=<hmac_signature>
X-CrawlProof-Timestamp: <unix_timestamp>
```

## Data Model

V1 tables:

- `integrations`: provider config and encrypted credentials.
- `event_outbox`: durable outbound event queue with retry metadata.
- `webhook_events`: inbound/outbound audit log with sanitized payloads and idempotency keys.

## Retry Policy

- Retry HTTP `429`, `500`, `502`, `503`, `504`, network timeouts, and DNS failures.
- Do not retry HTTP `400`, `401`, `403`, or schema validation errors until config changes.
- Backoff: 1 minute, 5 minutes, 15 minutes, 1 hour, 6 hours, 24 hours.
- Max attempts: 10.
- Move to dead-letter after max attempts.

## UI Requirements

Future path:

```txt
/dashboard/settings/integrations/posthog
```

Sections:

- Connection status
- PostHog host
- Project API key
- Event category toggles
- Customer-owned PostHog toggle
- Send test event button
- Inbound webhook URL
- Shared secret rotation
- Recent deliveries
- Error log

Event category toggles:

- Product lifecycle events
- Bot/crawler events
- Rule/action events
- Link exchange events
- Billing events
- Debug/test events

## API Requirements

- `POST /api/integrations/posthog/config`: validate and save config, encrypt key, write audit log.
- `POST /api/integrations/posthog/test`: queue/send `crawlproof_posthog_test`.
- `POST /api/integrations/posthog/webhook`: verify secret, validate schema, enforce idempotency, run allowlisted action, write webhook audit log.

## Security And Privacy Requirements

- All privileged integration actions run server-side only.
- Store PostHog keys encrypted at rest.
- Never expose PostHog API keys in browser-rendered pages.
- Redact secrets from logs.
- Validate inbound payloads with Zod.
- Use a shared secret for V1 inbound calls.
- Add HMAC signatures in V1.1.
- Add rate limiting per org/provider/IP.
- Add replay protection using idempotency keys and timestamp windows.
- Add allowlisted actions only.
- Hash or redact IP addresses and user agents before forwarding unless raw analytics is explicitly enabled.
- Do not send request bodies, raw IPs, raw user agents, payment secrets, access tokens, API keys, or session cookies by default.

## Implementation Plan

### Phase 1: Internal CrawlProof -> PostHog

- Add server-side event capture helper.
- Define event taxonomy.
- Emit activation, domain, bot, and billing events.
- Add environment variables for CrawlProof-owned PostHog.
- Add safe payload sanitizer.

### Phase 2: Event Outbox

- Add `event_outbox` table.
- Add retry worker.
- Add dead-letter handling.
- Add admin delivery logs.

### Phase 3: Customer-Owned PostHog

- Add integration settings page.
- Add encrypted credential storage.
- Add event category toggles.
- Add test event.

### Phase 4: PostHog -> CrawlProof

- Add inbound webhook endpoint.
- Add shared-secret verification.
- Add idempotency.
- Add supported action allowlist.
- Add audit logs.

### Phase 5: Workflow Recipes

- Activation completed -> tag user in CrawlProof.
- High-intent lead -> create admin alert.
- Bot volume spike -> create alert.
- Billing risk -> tag org.
- Experiment assignment -> update safe org property.

## Acceptance Criteria

Functional:

- CrawlProof can send product events to PostHog.
- CrawlProof can send bot/crawler events to PostHog.
- CrawlProof can receive verified webhook calls from PostHog.
- Integration settings can be enabled, disabled, tested, and audited.
- Failed outbound events retry without impacting app UX.

Security:

- API keys are encrypted.
- Inbound calls require verification.
- Inbound actions are allowlisted.
- Sensitive payload values are redacted.
- Idempotency prevents duplicate action execution.

Operational:

- Admin can inspect recent deliveries.
- Admin can replay failed outbound events.
- Logs include sanitized payload previews.
- Dead-letter events are visible.

## Metrics

- Number of PostHog integrations connected
- Number of events delivered to PostHog
- Delivery success rate
- Average delivery latency
- Retry count by provider
- Dead-letter count
- Number of inbound PostHog workflow calls
- Number of activation workflows triggered
- Number of customers using customer-owned PostHog

## References

- PostHog webhook destinations: https://posthog.com/docs/cdp/destinations/webhook
- PostHog workflow builder and webhook triggers: https://posthog.com/docs/workflows/workflow-builder
