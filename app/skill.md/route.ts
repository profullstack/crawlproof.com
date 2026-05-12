const body = `---
name: crawlproof
description: Run an AEO audit on a URL and return a structured report.
version: 1.0.0
---

# CrawlProof Skill

This site offers an AEO audit service. An agent can use it to:

- Submit a URL and receive a structured audit report.
- Read public audit reports under https://crawlproof.com/r/{share_token}.
- Read documentation about audit checks.

## Endpoints
- POST https://crawlproof.com/ (web form) — submit a URL for audit.
- GET  https://crawlproof.com/r/{token} — read a public audit report.

## Notes
- Free tier is rate-limited to 3 audits per IP per day.
- API access is planned for v1.1.
`;

export async function GET() {
  return new Response(body, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
