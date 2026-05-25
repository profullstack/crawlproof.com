// Shared helper for the social OAuth /start routes. Each provider needs
// a small set of env vars (client id + secret). If any are missing, we
// return a clear HTML error page up front instead of letting the
// platform module throw deep in the call stack and surface a generic
// 500 to the user.

import { NextResponse } from "next/server";
import { env } from "@/lib/env";

interface PlatformConfig {
  label: string;
  /** Env keys required for the OAuth flow to function. */
  envKeys: string[];
  /** Env keys we read (i.e. values from lib/env.ts). */
  envValues: () => Array<string | undefined>;
}

const PLATFORMS: Record<string, PlatformConfig> = {
  threads: {
    label: "Threads",
    envKeys: ["META_APP_ID", "META_APP_SECRET"],
    envValues: () => [env.metaAppId, env.metaAppSecret],
  },
  facebook: {
    label: "Facebook",
    envKeys: ["META_APP_ID", "META_APP_SECRET"],
    envValues: () => [env.metaAppId, env.metaAppSecret],
  },
  linkedin: {
    label: "LinkedIn",
    envKeys: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    envValues: () => [env.linkedinClientId, env.linkedinClientSecret],
  },
  x: {
    label: "X (Twitter)",
    envKeys: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
    envValues: () => [env.xClientId, env.xClientSecret],
  },
  reddit: {
    label: "Reddit",
    envKeys: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
    envValues: () => [env.redditClientId, env.redditClientSecret],
  },
};

/**
 * Returns null when the platform is fully configured. Otherwise returns
 * a NextResponse with a 503 + a human-readable error page that tells
 * the user (and an admin reading the page) exactly which env vars are
 * missing and where to set them.
 */
export function requirePlatformEnv(platform: string): NextResponse | null {
  const cfg = PLATFORMS[platform];
  if (!cfg) return null; // Unknown platform — let downstream handle it.
  const values = cfg.envValues();
  const missing = cfg.envKeys.filter((_, i) => !values[i]);
  if (missing.length === 0) return null;

  const html = renderNotConfiguredPage({
    label: cfg.label,
    missing,
  });
  return new NextResponse(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderNotConfiguredPage(input: {
  label: string;
  missing: string[];
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${input.label} OAuth not configured · CrawlProof</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font: 15px/1.6 system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
    h1 { font-size: 1.5rem; margin: 0 0 .75rem; }
    code { background: #f3f3f3; padding: .1em .3em; border-radius: 3px; font-size: 0.9em; }
    pre { background: #0b0d10; color: #eaeaea; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.85em; }
    .muted { color: #6b6b6b; }
    a { color: #2563eb; }
    @media (prefers-color-scheme: dark) {
      body { background: #0a0a0a; color: #eaeaea; }
      code { background: #1a1a1a; }
      .muted { color: #9b9b9b; }
    }
  </style>
</head>
<body>
  <h1>${input.label} OAuth isn't set up yet</h1>
  <p>CrawlProof can't start a ${input.label} OAuth flow because the
  server is missing credentials. You'll need an admin to add them and
  redeploy.</p>

  <h2 style="font-size:1.05rem;margin-top:1.5rem">Admin: add these to Railway</h2>
  <pre>${input.missing.map((k) => `${k}=…`).join("\n")}</pre>
  <p class="muted">Register an app on the provider's developer
  dashboard, paste the client id + secret into the Railway service
  variables, redeploy.</p>

  <p style="margin-top:2rem"><a href="/dashboard">← Back to dashboard</a></p>
</body>
</html>`;
}
