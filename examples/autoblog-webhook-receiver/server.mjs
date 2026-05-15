#!/usr/bin/env node
// Minimal CrawlProof Autoblog webhook receiver — zero dependencies.
//
// Usage:
//   CRAWLPROOF_WEBHOOK_SECRET=cp_lx_… node server.mjs
//
// Optional env:
//   PORT             default 3000
//   POSTS_DIR        default ./posts
//   DELIVERIES_FILE  default ./deliveries.json (idempotency state)
//
// Every received article lands as:
//   ./posts/{slug}.md   — front-matter + body
//   ./posts/{slug}.json — full webhook payload (for debugging)
//
// Replies 2xx fast; CrawlProof's delivery loop times out at 10s.

import http from "node:http";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const SECRET = process.env.CRAWLPROOF_WEBHOOK_SECRET ?? "";
const POSTS_DIR = path.resolve(process.env.POSTS_DIR ?? "./posts");
const DELIVERIES_FILE = path.resolve(process.env.DELIVERIES_FILE ?? "./deliveries.json");

if (!SECRET) {
  console.error("CRAWLPROOF_WEBHOOK_SECRET is not set. Refusing to start.");
  process.exit(2);
}

// Load delivery-id dedupe state from disk so a restart can't double-process.
/** @type {Set<string>} */
let seenDeliveries = new Set();
try {
  const raw = await fs.readFile(DELIVERIES_FILE, "utf8");
  const arr = JSON.parse(raw);
  if (Array.isArray(arr)) seenDeliveries = new Set(arr);
} catch {
  // First run — file doesn't exist yet.
}

async function persistDeliveries() {
  // Keep the file small — cap to the most recent 10k deliveries.
  const arr = Array.from(seenDeliveries).slice(-10_000);
  await fs.writeFile(DELIVERIES_FILE, JSON.stringify(arr));
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function safeSlug(slug) {
  // The slug comes from CrawlProof but we never trust input that ends up
  // in a filesystem path. Strip anything that isn't kebab-safe.
  return String(slug)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `post-${Date.now()}`;
}

function frontMatter(article) {
  const tags = Array.isArray(article.tags) ? article.tags : [];
  // Build as an array, but only filter out *empty conditional* lines —
  // never strip the trailing blank that separates the YAML block from
  // the body.
  const head = [
    "---",
    `title: ${JSON.stringify(article.title ?? "")}`,
    `slug: ${article.slug}`,
    `description: ${JSON.stringify(article.meta_description ?? "")}`,
    `date: ${article.created_at ?? new Date().toISOString()}`,
    tags.length ? `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]` : "tags: []",
    article.image_url ? `image: ${article.image_url}` : null,
    "---",
  ].filter((line) => line !== null);
  return head.join("\n") + "\n\n";
}

async function writePost(article) {
  await fs.mkdir(POSTS_DIR, { recursive: true });
  const slug = safeSlug(article.slug ?? article.title);
  const md = frontMatter(article) + (article.content_markdown ?? "") + "\n";
  await fs.writeFile(path.join(POSTS_DIR, `${slug}.md`), md);
  await fs.writeFile(
    path.join(POSTS_DIR, `${slug}.json`),
    JSON.stringify(article, null, 2),
  );
  return slug;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  // Verify bearer.
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!timingSafeEqualStr(bearer, SECRET)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }

  // Idempotency.
  const deliveryId = String(req.headers["x-crawlproof-delivery"] ?? "");
  if (deliveryId && seenDeliveries.has(deliveryId)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, dedupe: true }));
    return;
  }

  // Parse + validate.
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(err.message ?? err) }));
    return;
  }
  if (payload?.event_type !== "lx.publish_article") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unexpected event_type" }));
    return;
  }
  const article = payload?.data?.article;
  if (!article?.slug || typeof article.content_markdown !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "missing article fields" }));
    return;
  }

  try {
    const slug = await writePost(article);
    if (deliveryId) {
      seenDeliveries.add(deliveryId);
      await persistDeliveries();
    }
    console.log(`[receiver] wrote ${slug}.md (delivery=${deliveryId || "(none)"})`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, slug }));
  } catch (err) {
    console.error("[receiver] write failed", err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "write failed" }));
  }
});

server.listen(PORT, () => {
  console.log(`[receiver] listening on http://localhost:${PORT}`);
  console.log(`[receiver] posts → ${POSTS_DIR}`);
  console.log(`[receiver] deliveries → ${DELIVERIES_FILE}`);
});
