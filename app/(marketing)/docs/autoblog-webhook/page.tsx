export const metadata = {
  title: "Autoblog webhook",
  description:
    "How CrawlProof delivers Autoblog articles to your site. CloudEvents 1.0 envelope, Standard Webhooks signing, payload schema, retry behavior, and a copy-paste receiver.",
  alternates: { canonical: "/docs/autoblog-webhook" },
};

export default function AutoblogWebhookDocsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-4xl font-extrabold">Autoblog webhook</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        CrawlProof generates one SEO blog post per scheduled slot and POSTs
        it to your endpoint. The wire shape is a{" "}
        <a className="underline" href="https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md" target="_blank" rel="noreferrer">CloudEvents 1.0</a>{" "}
        envelope, signed per{" "}
        <a className="underline" href="https://www.standardwebhooks.com/" target="_blank" rel="noreferrer">Standard Webhooks</a>.
        Your endpoint owns the actual publish — turning the payload into a
        row in your CMS, a file in your repo, an MDX file in S3, whatever.
      </p>
      <p className="mt-3 text-[var(--color-muted)]">
        The easiest receiver is{" "}
        <code className="font-mono">@profullstack/autoblog</code>: its{" "}
        <code>verifyAndParse</code> helper validates the bearer + signature
        + envelope in a single call and hands you a normalized{" "}
        <code>Post</code> object.
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
            Content type{" "}
            <code className="font-mono">application/cloudevents+json</code>.
          </li>
          <li>10-second timeout. Reply <code>2xx</code> to acknowledge.</li>
        </ul>

        <h3 className="mt-6 text-lg font-bold">Headers</h3>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`Authorization:      Bearer <secret-key>                  # token from /autoblog/setup
webhook-id:         <event uuid>                        # stable across retries
webhook-timestamp:  <unix seconds>                       # delivery time
webhook-signature:  v1,<base64 HMAC-SHA256>              # signs id.timestamp.body
Content-Type:       application/cloudevents+json
User-Agent:         @profullstack/autoblog/0.2`}</pre>
        <p className="text-sm text-[var(--color-muted)]">
          The bearer is a secret you generate on your receiver site (e.g.
          a per-source token from your blog's admin page) and paste into{" "}
          <code className="font-mono">/autoblog/setup</code>. Crawlproof
          stores it verbatim and uses the same value as the HMAC key for
          the signature header.
        </p>
        <p className="text-sm text-[var(--color-muted)]">
          <strong>Signing details (Standard Webhooks):</strong> the
          signature is{" "}
          <code className="font-mono">
            HMAC-SHA256(secret, &quot;{`{id}.{timestamp}.{body}`}&quot;)
          </code>{" "}
          base64-encoded and prefixed with{" "}
          <code className="font-mono">v1,</code>. Receivers should reject
          deliveries whose timestamp is more than 5 minutes from now (replay
          defense). Multiple space-separated signatures are allowed in the
          header so we can rotate keys without dropping in-flight deliveries.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Body</h2>
        <p className="text-sm text-[var(--color-muted)]">
          CloudEvents 1.0 envelope. The <code>data.post</code> object is the
          canonical, normalized blog post.
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`{
  "specversion": "1.0",
  "id":          "0193a8b9-d2c4-7f44-9a31-3f1c2e7b9a01",
  "type":        "com.crawlproof.post.published.v1",
  "source":      "https://crawlproof.com",
  "subject":     "post:<id>",
  "time":        "2026-05-15T09:00:00.000Z",
  "datacontenttype": "application/json",
  "data": {
    "post": {
      "id":            "uuid",
      "url":           "https://your-site/blog/{slug}",
      "canonical_url": "https://your-site/blog/{slug}",
      "title":         "string",
      "slug":          "kebab-case-slug",
      "excerpt":       "≤240-char prose summary" | null,
      "html":          "<p>…</p>",
      "markdown":      "..." | null,
      "status":        "published",
      "published_at":  "ISO-8601",
      "updated_at":    "ISO-8601",
      "author":        null,
      "tags":          ["seo", "ai bots"],
      "categories":    [],
      "featured_image": { "url": "https://...", "alt": "..." } | null
    }
  }
}`}</pre>
        <p className="text-sm text-[var(--color-muted)]">
          <code className="font-mono">meta_description</code> (≤160 chars,
          SEO copy) is sent inside the legacy fields when present but the
          canonical short summary lives in{" "}
          <code className="font-mono">post.excerpt</code> (≤240 chars).
          Receivers should prefer <code>excerpt</code>.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Example — send a valid signed request</h2>
        <p className="text-sm leading-relaxed">
          Drop-in bash that POSTs a real, validly-signed CloudEvents
          envelope at your receiver. Only{" "}
          <code className="font-mono">curl</code> +{" "}
          <code className="font-mono">openssl</code> +{" "}
          <code className="font-mono">uuidgen</code> — no Node, no
          Python. Set the two variables at the top and run; this is the
          same shape CrawlProof puts on the wire for a real delivery.
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`# Replace these two and run.
URL="https://your-site.example/api/webhooks/crawlproof"
SECRET="<secret-key>"

ID="$(uuidgen | tr 'A-Z' 'a-z')"
TS="$(date +%s)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

BODY=$(cat <<JSON
{"specversion":"1.0","id":"$ID","type":"com.crawlproof.post.published.v1","source":"https://crawlproof.com","subject":"post:$ID","time":"$NOW","datacontenttype":"application/json","data":{"post":{"id":"$ID","url":"$URL","canonical_url":"$URL","title":"Local test post","slug":"local-test-post","excerpt":"Verifying the autoblog webhook end-to-end from curl.","html":"<p>Hello from a signed test webhook.</p>","markdown":"Hello from a signed test webhook.","status":"published","published_at":"$NOW","updated_at":"$NOW","author":null,"tags":["test"],"categories":[],"featured_image":null}}}
JSON
)

SIG="v1,$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" \\
  | openssl dgst -sha256 -hmac "$SECRET" -binary \\
  | openssl base64 -A)"

curl -sS -X POST "$URL" \\
  -H "Authorization: Bearer $SECRET" \\
  -H "webhook-id: $ID" \\
  -H "webhook-timestamp: $TS" \\
  -H "webhook-signature: $SIG" \\
  -H "Content-Type: application/cloudevents+json" \\
  --data-binary "$BODY"`}</pre>
        <p className="text-sm text-[var(--color-muted)]">
          The signing string is{" "}
          <code className="font-mono">{`{id}.{timestamp}.{body}`}</code>{" "}
          — exactly the same bytes that go in the headers + body. Edit
          one without regenerating the signature and the receiver will
          401, which is the whole point.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Retry</h2>
        <p className="text-sm leading-relaxed">
          At-least-once delivery. On 5xx, 408, 429, or network error we
          retry up to 3 attempts spaced at 0s / 10s / 60s. On any other 4xx
          we give up immediately — that's your endpoint asking us to stop.
          The <code className="font-mono">webhook-id</code> stays stable
          across retries of the same article, so dedupe on that.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Receiver — recommended (SDK)</h2>
        <p className="text-sm leading-relaxed">
          The 30-LOC version. The SDK handles bearer + signature +
          envelope validation; you handle storage.
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`// npm i @profullstack/autoblog
import { verifyAndParse } from "@profullstack/autoblog";

export async function POST(req: Request) {
  const body = await req.text(); // raw bytes — needed for signature
  const r = verifyAndParse({
    headers: Object.fromEntries(req.headers),
    body,
    opts: { secret: process.env.CRAWLPROOF_WEBHOOK_SECRET! },
  });
  if (!r.ok) return new Response(r.reason, { status: r.status });

  await savePost(r.post); // your CMS / DB
  return new Response(null, { status: 200 });
}`}</pre>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Receiver — recommended (SDK + gate)</h2>
        <p className="text-sm leading-relaxed">
          If your blog is in a topical network, add the network gate so
          off-niche or low-quality posts are rejected before they touch
          your DB. The SDK ships{" "}
          <code className="font-mono">@profullstack/autoblog/quality</code>{" "}
          for this:
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`import { verifyAndParse } from "@profullstack/autoblog";
import { gatePost } from "@profullstack/autoblog/quality";

export async function POST(req: Request) {
  const body = await req.text();
  const r = verifyAndParse({
    headers: Object.fromEntries(req.headers),
    body,
    opts: { secret: process.env.CRAWLPROOF_WEBHOOK_SECRET! },
  });
  if (!r.ok) return new Response(r.reason, { status: r.status });

  const gated = await gatePost(r.post, {
    allowedNiches: ["security", "ctem", "soc"],
    heuristics: { minWordCount: 500, maxLinkDensity: 1.0 },
    minQualityScore: 6,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  });
  if (!gated.ok) {
    return new Response(gated.reasons.join("; "), {
      status: gated.stage === "niche" ? 403 : 422,
    });
  }

  await savePost(r.post);
  return new Response(null, { status: 200 });
}`}</pre>
        <p className="text-sm text-[var(--color-muted)]">
          Niche match is loose by default (case-insensitive, partial-word
          overlap). Empty <code>allowedNiches</code> = accept any niche.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Receiver — from scratch (no SDK)</h2>
        <p className="text-sm">
          If you can't add a dependency, the verification is ~40 LOC of
          standard library. <code className="font-mono">crypto.timingSafeEqual</code>{" "}
          for the bearer, <code className="font-mono">crypto.createHmac</code>{" "}
          for the signature.
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`import { NextResponse } from "next/server";
import crypto from "node:crypto";

const SECRET = process.env.CRAWLPROOF_WEBHOOK_SECRET!;
const TOLERANCE_SEC = 5 * 60;

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.text();
  const h = (k: string) => req.headers.get(k) ?? "";

  // Bearer.
  const bearer = h("authorization").replace(/^Bearer\\s+/i, "");
  if (
    bearer.length !== SECRET.length ||
    !crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(SECRET))
  ) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // Standard Webhooks signature.
  const id = h("webhook-id");
  const ts = h("webhook-timestamp");
  const sig = h("webhook-signature");
  const now = Math.floor(Date.now() / 1000);
  if (!id || !ts || !sig) return NextResponse.json({ ok: false }, { status: 401 });
  if (Math.abs(now - Number(ts)) > TOLERANCE_SEC) {
    return NextResponse.json({ ok: false, reason: "stale" }, { status: 401 });
  }
  const expected =
    "v1," +
    crypto.createHmac("sha256", SECRET).update(\`\${id}.\${ts}.\${body}\`).digest("base64");
  const ok = sig.split(/\\s+/).some(
    (s) =>
      s.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)),
  );
  if (!ok) return NextResponse.json({ ok: false, reason: "bad sig" }, { status: 401 });

  // Envelope.
  const evt = JSON.parse(body);
  if (evt?.specversion !== "1.0" || !evt?.data?.post) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  await savePost(evt.data.post); // your storage
  return NextResponse.json({ ok: true });
}`}</pre>
      </section>

      <section className="mt-10 space-y-2">
        <h2 className="text-2xl font-bold">Local testing</h2>
        <p className="text-sm leading-relaxed">
          We ship a zero-dependency reference receiver under{" "}
          <code className="font-mono">examples/autoblog-webhook-receiver/</code>{" "}
          in the CrawlProof repo. Drop your secret into{" "}
          <code className="font-mono">CRAWLPROOF_WEBHOOK_SECRET</code>, run{" "}
          <code>node server.mjs</code>, expose it via ngrok or Cloudflare
          Tunnel, and paste the public URL into{" "}
          <a className="underline" href="/autoblog/setup">
            /autoblog/setup
          </a>
          . Hit <em>Generate article now</em> on the dashboard to fire an
          immediate delivery.
        </p>
      </section>
    </main>
  );
}
