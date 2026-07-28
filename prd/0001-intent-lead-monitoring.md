---
openprd: "0.2"
id: "0001"
title: "Compete with intent-monitoring tools on the parts that matter"
status: Partially Implemented
authors:
  - anthony@profullstack.com
created: 2026-07-28
updated: 2026-07-28
repo: https://github.com/profullstack/crawlproof.com
discussion:
implementation: R1, R2 shipped; R3-R7 outstanding
tags: [leads, outreach, intent, competitive]
supersedes:
superseded-by:
---

## Problem

CrawlProof shipped intent qualification today (#157, #158, #159): campaigns
sweep Reddit, forums, Q&A and review sites for people publicly asking to buy,
score them on explicitness × recency, and gate leads on a threshold.

Leadmatically sells that as a whole product, at $19–$1,499/month. Reviewing
what they offer against what we now have, the scoring engine is comparable and
in two respects ours is stricter — we refuse people who said "no vendors", and
we refuse drafts that state anything the campaign never claimed. But they beat
us on everything that happens *after* a signal is found, and that gap is where
the value of finding it goes.

Three concrete losses:

1. **We find a request and tell nobody.** They alert instantly on Email, Slack
   or Telegram so the user "can be the first helpful reply". A conversation
   worth answering has a useful life measured in hours; ours sits in a table
   until someone loads the Leads page. Finding a lead nobody is told about is
   indistinguishable from not finding it.

2. **We match on keywords only.** They score against a *business description* —
   what you sell, in prose — as well as keywords. Ours disqualifies anything
   without a literal keyword hit, so "our pipeline keeps falling over under
   traffic" is dropped by a load-testing campaign that listed "load testing".
   The best-phrased requests are the ones least likely to use our words.

3. **We do not help with the reply, or learn from it.** They keep a saved reply
   prompt (tone and talking points) so replies stay consistent, and they track
   what happened to each one — replied, removed, unavailable. We have a status
   column nothing writes and no UI, so the intent queue cannot report whether
   any of it works.

## Goals

- A user learns about a qualifying conversation within one tick, without
  visiting the app.
- Requests phrased in the user's own words are found even when they avoid the
  campaign's keywords, without lowering precision.
- Every signal ends in a recorded outcome, so per-source value is measurable
  rather than assumed.
- The intent queue answers "which of these is worth my next ten minutes"
  without opening five tabs.

## Non-Goals

- **Facebook and Instagram monitoring.** Leadmatically lists both. Neither
  carries meaningful public buying intent and neither is readable without
  authenticated access we do not have. Listing them would be coverage we cannot
  deliver, and this product's line is that a claim has to be true.
- **Auto-posting replies.** They draft for review and so do we. Posting to a
  social platform unattended is how an account gets banned and how the product
  becomes a spam vector; the human stays in the loop deliberately.
- **Per-keyword subscription tiers.** Their pricing meters businesses and
  keywords. CrawlProof meters credits, and bolting a second quota system beside
  it would make the cost of a run unpredictable — which is the one thing the
  billing work this week was for.
- **Replacing the email pipeline.** Intent and outreach answer different
  questions. A person on a forum is not a domain to mail, and #157 already
  keeps them in separate tables for that reason.

## Users

- **Founder or solo operator** running one project, who wants to be told when
  somebody asks for what they sell and is not going to poll a dashboard.
- **Agency running campaigns per client**, who needs the queue segmented by
  project and needs to know which source is worth the credits.

## Requirements

- R1 [P0] **[shipped]** Alert on new qualifying signals by email, batched per campaign per
  tick, with the strongest first and a direct link to each conversation. Never
  alert twice for the same signal.
- R2 [P0] **[shipped]** Score against a campaign's own description of what it sells, in
  addition to keywords. A description match qualifies a signal that no keyword
  matched; neither path may bypass the disqualifiers.
- R3 [P0] Record an outcome per signal — working, replied, won, lost, dismissed
  — from the queue, so the status column that already exists gets written.
- R4 [P1] Report per-source performance: signals found, replied and won by
  source, so a source that never converts can be switched off.
- R5 [P1] A saved reply prompt per campaign (tone, talking points) and an
  AI-drafted reply for a selected signal, checked by the existing grounding
  guard before it is shown.
- R6 [P2] Slack and Telegram alert channels, behind the same batching as R1.
- R7 [P2] Keyword buckets by intent kind (brand, problem, competitor), so a
  competitor complaint can be routed differently from a generic request.

## UX Notes

Alerts are batched per tick rather than sent per signal: a sweep that finds
eleven conversations must produce one email, not eleven. The subject carries
the count and the best score so it is triageable from a notification.

The queue already sorts by score. Outcome buttons go inline on each row —
recording an outcome is the most frequent action and should not need a detail
page.

A description-matched signal must say so in its reasons, because a user who
listed keywords will otherwise not understand why an unmatched post appeared.

## Success Metrics

- Median time from a signal being found to being seen drops below one hour
  (currently unbounded: it is however long until someone opens the page).
- Description matching adds qualifying signals that keyword matching missed,
  at a false-positive rate no worse than the keyword path — measured by
  dismissal rate per match path.
- Every source has a reply rate after 30 days, so R4 can retire the ones that
  do not earn their credits.

## Risks & Open Questions

- **Alert fatigue.** A campaign with a low bar could mail hourly. Batching
  bounds it to one per campaign per tick, but a daily cap may be needed;
  deferred until there is a real send rate to look at.
- **Description matching costs a model call per signal.** Cheap per call and
  unbounded per sweep. Mitigated by only scoring what the cheap path already
  short-listed, never the raw result set.
- **Scoring on prose invites drift.** Keyword matching is legible and wrong in
  obvious ways; a model deciding relevance is wrong in ways nobody sees. The
  reasons string has to carry the model's stated basis, or R2 becomes
  unauditable.
- Open: whether a competitor complaint (R7) should outrank a generic request.
  It is stronger intent but a worse first impression to answer.
