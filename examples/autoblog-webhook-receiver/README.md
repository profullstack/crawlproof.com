# Autoblog webhook receiver

A minimal, zero-dependency Node receiver for the CrawlProof Autoblog
webhook. Every accepted article is written as Markdown to `./posts/`.

```
posts/
├── how-to-detect-llm-bots.md
├── how-to-detect-llm-bots.json   # full webhook payload (debug)
└── ...
deliveries.json                    # idempotency state (recent 10k UUIDs)
```

## Run it

```bash
# Set the bearer secret shown in /autoblog/setup.
export CRAWLPROOF_WEBHOOK_SECRET=cp_lx_your-secret-here

node server.mjs
# [receiver] listening on http://localhost:3000
# [receiver] posts → /your/cwd/posts
```

Optional env:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port. |
| `POSTS_DIR` | `./posts` | Where Markdown files land. |
| `DELIVERIES_FILE` | `./deliveries.json` | Persistent dedupe state. |

## Expose it to CrawlProof

The webhook URL has to be reachable from the public internet. Pick one:

```bash
# Option A — ngrok
ngrok http 3000
# Use the https://*.ngrok-free.app URL it prints.

# Option B — cloudflared
cloudflared tunnel --url http://localhost:3000
```

Paste the public URL into `/autoblog/setup` → "Webhook URL", save, then
click **Generate article now** on the dashboard to fire an immediate
delivery.

## What you get

Each post file looks like:

```markdown
---
title: "How to detect LLM bots on your blog"
slug: how-to-detect-llm-bots
description: "A practical guide to identifying GPTBot, ClaudeBot, and other AI crawlers."
date: 2026-05-14T09:00:00.000Z
tags: ["seo", "ai bots", "logs"]
image: https://....supabase.co/storage/v1/object/public/lx-article-images/...
---

The first AI bot wave hit production logs in early 2024…
```

Most static-site generators (Astro, Hugo, Eleventy, Next.js MDX) read
this front-matter shape as-is.

## How it's safe

- **Bearer verified** with `crypto.timingSafeEqual` — constant-time
  comparison, immune to timing oracles.
- **Idempotency** — the `X-Crawlproof-Delivery` UUID is stable across
  retries; we persist seen IDs to `deliveries.json` so a restart can't
  double-process.
- **Slug sanitized** before it touches the filesystem (lowercase, kebab,
  capped at 80 chars). The webhook is from CrawlProof, but a defense
  against path traversal costs nothing.
- **Payload capped at 4 MB** to prevent a malicious source from
  exhausting memory.

## Replacing the storage step

The `writePost` function is the only place that touches storage. Swap it
out for:

- `await prisma.post.create(...)` — write to your CMS database.
- `await s3.putObject(...)` — drop the Markdown into an S3 bucket.
- `await fetch('https://your-cms/api/posts', { method: 'POST', body: ... })`
  — forward to a different service.

Everything else (bearer check, dedupe, validation) stays.
