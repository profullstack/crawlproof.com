export const metadata = {
  title: "Autoblog webhook",
  description:
    "How CrawlProof delivers Autoblog articles to your site. Payload schema, headers, retry behavior, and a copy-paste receiver.",
  alternates: { canonical: "/docs/autoblog-webhook" },
};

export default function AutoblogWebhookDocsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-4xl font-extrabold">Autoblog webhook</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        CrawlProof generates one SEO blog post per scheduled slot and POSTs
        it to your endpoint. Your endpoint owns the actual publish — turning
        the payload into a row in your CMS, a file in your repo, an MDX file
        in S3, whatever.
      </p>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Request</h2>
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          <li>
            Method <code className="font-mono">POST</code>
          </li>
          <li>
            URL: whatever you saved on{" "}
            <a className="underline" href="/autoblog/setup">
              /autoblog/setup
            </a>
            .
          </li>
          <li>
            Content type <code className="font-mono">application/json</code>.
          </li>
          <li>10-second timeout. Reply <code>2xx</code> to acknowledge.</li>
        </ul>

        <h3 className="mt-6 text-lg font-bold">Headers</h3>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`Authorization: Bearer cp_lx_<your-secret>
Content-Type:  application/json
User-Agent:    Crawlproof-LinkExchange/1.0
X-Crawlproof-Delivery: <uuid>   # stable across retries of the same article`}</pre>
        <p className="text-sm text-[var(--color-muted)]">
          The bearer is the secret shown when you first save Autoblog
          settings (or after you click <em>Regenerate</em>). Treat it like
          a password — anyone with it can post articles to your endpoint.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Body</h2>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`{
  "event_type": "lx.publish_article",
  "timestamp": "2026-05-14T09:00:00.000Z",
  "data": {
    "article": {
      "id": "uuid",
      "title": "string",
      "slug": "kebab-case-slug",
      "meta_description": "string",
      "content_markdown": "string",
      "content_html": "string",
      "image_url": "https://.../lx-article-images/{site}/{slug}.png" | null,
      "tags": ["..."],
      "internal_links": [
        { "url": "https://your-site/...", "title": "..." }
      ],
      "outbound_links": [],
      "created_at": "ISO-8601"
    }
  }
}`}</pre>
        <p className="text-sm text-[var(--color-muted)]">
          <code className="font-mono">outbound_links</code> is reserved for
          the upcoming Link Exchange — it stays empty during the Autoblog
          phase, but receivers should not error if it's present and
          non-empty later.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Retry</h2>
        <p className="text-sm leading-relaxed">
          At-least-once delivery. On a 5xx, 408, 429, or network error we
          retry up to 3 attempts spaced at 0s / 10s / 60s. On a 4xx (other
          than 408/429) we give up immediately — that's your endpoint
          asking us to stop. The{" "}
          <code className="font-mono">X-Crawlproof-Delivery</code> UUID is
          stable across retries: hash it (or store it) so a second attempt
          for the same article doesn't create a duplicate post.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Receiver — Next.js route handler</h2>
        <p className="text-sm">
          Drop this in <code className="font-mono">app/api/autoblog/route.ts</code>{" "}
          (or anywhere your app routes POSTs). It verifies the bearer,
          dedupes by delivery id, and writes the article. Replace the
          comment block with your actual storage.
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`import { NextResponse } from "next/server";
import crypto from "node:crypto";

const SECRET = process.env.CRAWLPROOF_WEBHOOK_SECRET!;
const seen = new Set<string>(); // swap for Redis / DB in prod

export const runtime = "nodejs";

export async function POST(req: Request) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  if (
    !bearer ||
    bearer.length !== SECRET.length ||
    !crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(SECRET))
  ) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const deliveryId = req.headers.get("x-crawlproof-delivery") ?? "";
  if (deliveryId && seen.has(deliveryId)) {
    return NextResponse.json({ ok: true, dedupe: true });
  }

  const payload = await req.json();
  if (payload?.event_type !== "lx.publish_article") {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const article = payload.data.article;
  // ↓↓↓ Replace this with your actual publish step.
  console.log("publish", article.slug, article.title);

  if (deliveryId) seen.add(deliveryId);
  return NextResponse.json({ ok: true });
}`}</pre>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Receiver — plain Express</h2>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`import express from "express";
import crypto from "node:crypto";

const app = express();
const SECRET = process.env.CRAWLPROOF_WEBHOOK_SECRET!;
const seen = new Set();

app.post("/autoblog", express.json({ limit: "2mb" }), (req, res) => {
  const bearer = req.get("authorization")?.replace(/^Bearer\\s+/i, "") ?? "";
  if (
    bearer.length !== SECRET.length ||
    !crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(SECRET))
  ) return res.status(401).end();

  const deliveryId = req.get("x-crawlproof-delivery") ?? "";
  if (deliveryId && seen.has(deliveryId)) return res.json({ dedupe: true });

  if (req.body?.event_type !== "lx.publish_article") return res.status(400).end();

  const article = req.body.data.article;
  // … write to your CMS / storage here …

  if (deliveryId) seen.add(deliveryId);
  res.json({ ok: true });
});`}</pre>
      </section>

      <section className="mt-10 space-y-2">
        <h2 className="text-2xl font-bold">Local testing</h2>
        <p className="text-sm leading-relaxed">
          We ship a zero-dependency reference receiver under{" "}
          <code className="font-mono">examples/autoblog-webhook-receiver/</code>{" "}
          in the CrawlProof repo. It verifies the bearer, dedupes by
          delivery ID, and writes each article as Markdown with YAML
          front-matter to <code>./posts/</code> — drop-in compatible with
          Astro, Hugo, Eleventy, and most static-site generators.
        </p>
        <p className="text-sm leading-relaxed">
          To wire it up: <code>node server.mjs</code> with{" "}
          <code className="font-mono">CRAWLPROOF_WEBHOOK_SECRET</code> set,
          expose <code>localhost:3000</code> via ngrok or Cloudflare Tunnel,
          paste the public URL into{" "}
          <a className="underline" href="/autoblog/setup">
            /autoblog/setup
          </a>
          , then hit <em>Generate article now</em> on the dashboard.
        </p>
      </section>
    </main>
  );
}
