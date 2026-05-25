# vibeprompt.tech audit-engine recon

> Source: [github.com/dotsystemsdevs/vibe-prompt](https://github.com/dotsystemsdevs/vibe-prompt), MIT license. Clean-room reimplement of any rule we want is fair game; their literal code can also be copied with attribution if we ever want to. Going with reimplement — better fit with our existing `engine='rule'` checker shape and easier to attribute as "our engine."

## What they have

44 rules across 7 categories in `src/lib/audit/rules.ts`:

| Category | Rule count | Examples |
|---|---|---|
| seo | 9 | no H1 / multi-H1 / no meta desc / no canonical / no favicon / title length / etc. |
| conversion | 9 | no CTA / weak CTA / H1 too long / no social proof / no pricing / too many CTAs / no form / no FAQ / buzzwords |
| trust | 6 | no OG / no OG image / images no alt / no JSON-LD / no privacy link / target=_blank no noopener |
| structure | 7 | SPA detected / no nav / no main / no footer / no lang / no viewport / etc. |
| security | 5 | no CSP / no HSTS / no X-Frame-Options / no X-Content-Type-Options / no Referrer-Policy |
| performance | 3 | render-blocking scripts / images no lazy-load / etc. |
| aeo | 5 | robots blocks AI crawlers / no llms.txt / no FAQ schema / no Q-style headings / no Twitter card |

Per-finding shape: `{ id, category, severity, effort, title, description, fix, scoreImpact }`. Score is 100 - sum(scoreImpact of failed rules). They also produce a category breakdown + a "quick wins" list (severity != high + effort=quick).

## What we already cover (in `lib/audit/checks/`)

| vibeprompt rule | crawlproof equivalent |
|---|---|
| seo_no_h1 / multiple_h1 | `homepage.h1` |
| seo_no_meta_desc / too_long / too_short | `homepage.description` |
| seo_no_title / too_long | `homepage.title` |
| seo_no_canonical | `homepage.canonical` |
| trust_no_og / no_og_image | `homepage.og` |
| trust_images_no_alt | `homepage.alt_text` |
| trust_no_structured_data | `schema.any` |
| structure_no_lang | `homepage.lang` |
| aeo_robots_blocks_ai | `robots.exists` (we go deeper — per-bot rules) |
| aeo_no_llms_txt | `llms_txt` |
| aeo_no_faq_schema | `schema.faq` |
| aeo_no_twitter_card | `homepage.twitter` |
| conv_no_cta | `positioning.cta` |
| conv_no_pricing | `positioning.pricing` |

That's ~14 rules we already match. We're stronger on AEO than they are (robots.txt per-bot rules, schema validity, security.txt, skill.md, ai-plugin.json, sitemap freshness).

## Net new rules worth adding

Real gaps we don't currently cover. ~22 rules grouped by where they slot in the existing checks/ structure.

### Conversion (most net new — we have none of these)
- `conv_weak_cta` — button text matches generic blocklist ("Submit", "Click here", "Learn more")
- `conv_h1_too_long` — H1 > 80 chars
- `conv_no_social_proof` — page contains no testimonial / review / "trusted by" / customer logo signals
- `conv_too_many_cta` — > 5 unique CTAs
- `conv_no_form` — no `<form>` / no `type="email"` input
- `conv_no_faq` — no FAQ heading + answer pattern
- `conv_buzzwords` — count of buzzword regex matches > N ("powerful", "seamless", "innovative", "revolutionary", etc.)

### Trust / structure
- `trust_no_privacy` — no privacy / terms link in footer
- `trust_blank_no_noopener` — target=_blank links missing rel=noopener
- `structure_no_nav` / `structure_no_main` / `structure_no_footer` — semantic landmarks
- `structure_no_viewport` — missing viewport meta

### Security headers
All five — we don't check HTTP response headers today, only HTML content:
- `sec_no_csp` — Content-Security-Policy missing
- `sec_no_hsts` — Strict-Transport-Security missing
- `sec_no_xfo` — X-Frame-Options missing (or CSP frame-ancestors)
- `sec_no_xcto` — X-Content-Type-Options missing
- `sec_no_referrer` — Referrer-Policy missing

### Performance
- `perf_render_blocking_scripts` — count of synchronous `<script>` in `<head>`
- `perf_images_no_lazy` — images without `loading="lazy"`

### Misc
- `seo_no_favicon` — no `<link rel="icon">`
- `aeo_no_question_headings` — heading text doesn't include "?" or start with "How / What / Why" — heuristic for AEO friendliness

## Build sketch

One new file `lib/audit/checks/conversion.ts` (10 conversion rules), one `lib/audit/checks/security-headers.ts` (5 rules, needs a HEAD request to grab response headers — easy add since we already fetch the page), and small additions to `homepage.ts` / `robots.ts` / `schema.ts` for the structural + AEO net-new.

Their score impact + severity buckets are reasonable; I'd reuse their values rather than re-tune from scratch (one of those decisions where their numbers come from experience and ours would come from a guess).

Estimated effort: ~1 day. Each new check is ~30 LOC + a test. Schema migration: none required — findings flow through the existing `audit_findings` table.

## Out of scope for this absorption

- Their UI ("audit-client.tsx", the report rendering). We have our own audit report UI; not copying.
- Their score formula. We have our own (`lib/audit/score.ts`); keep ours.
- Their parser shape (`ParsedPage` type). We do parsing inline in each check function; not switching to their pre-parsed bag of fields.
- Their prompt library and "vibe" branding entirely.

## Attribution

If we don't reimplement and just copy the rule data verbatim (the description / fix / scoreImpact strings), include `vibeprompt.tech (MIT)` in `lib/audit/checks/conversion.ts` header comment per MIT terms. If we clean-room reimplement (our own strings, same idea), no attribution required but a one-liner ack in the audit-engine docs is good form.
