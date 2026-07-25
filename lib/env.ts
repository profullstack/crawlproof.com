function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  selfAuditUrl: process.env.NEXT_PUBLIC_SELF_AUDIT_URL ?? "",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  maxmindLicenseKey: process.env.MAXMIND_LICENSE_KEY ?? "",
  geoLite2CityDbPath:
    process.env.MAXMIND_GEOLITE2_CITY_DB_PATH ??
    process.env.GEOLITE2_CITY_DB_PATH ??
    "data/GeoLite2-City.mmdb",
  // CoinPay — crypto credit purchases.
  coinpayMerchantId: process.env.COINPAY_MERCHANT_ID ?? "",
  coinpayApiKey: process.env.COINPAY_API_KEY ?? "",
  coinpayApiUrl: process.env.COINPAY_API_URL ?? "https://coinpayportal.com/api",
  coinpayWebhookSecret: process.env.COINPAY_WEBHOOK_SECRET ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  resendFrom: process.env.RESEND_FROM ?? "CrawlProof <reports@crawlproof.com>",
  smtpHost: process.env.SMTP_HOST ?? "",
  smtpPort: Number(process.env.SMTP_PORT ?? "587"),
  smtpUser: process.env.SMTP_USER ?? "",
  smtpPass: process.env.SMTP_PASS ?? "",
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpFrom:
    process.env.SMTP_FROM ??
    process.env.RESEND_FROM ??
    "CrawlProof <reports@crawlproof.com>",
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  twilioFrom: process.env.TWILIO_FROM ?? "",
  telnyxApiKey:
    process.env.TELNYX_API_KEY ??
    // Common misspelling; keep this alias so deploy envs don't silently fail.
    process.env.TELYNX_API_KEY ??
    "",
  telnyxFrom: process.env.TELNYX_FROM ?? process.env.TELYNX_FROM ?? "",
  // Tor SOCKS5 proxy for reaching .onion targets, e.g. socks5h://127.0.0.1:9050.
  // Empty = .onion audits/ads are unreachable (fail with a clear message).
  torSocksUrl: process.env.TOR_SOCKS_URL ?? "",
  workerUrl: process.env.WORKER_URL ?? "",
  workerSecret: process.env.WORKER_SHARED_SECRET ?? "",
  cronSecret: process.env.CRON_SECRET ?? "",
  // PostHog — internal-first analytics + workflow webhook integration.
  // POSTHOG_PROJECT_API_KEY is server-only and should never be rendered into
  // browser settings pages.
  posthogHost: process.env.POSTHOG_HOST ?? "https://app.posthog.com",
  posthogProjectApiKey: process.env.POSTHOG_PROJECT_API_KEY ?? "",
  posthogInboundWebhookSecret: process.env.POSTHOG_INBOUND_WEBHOOK_SECRET ?? "",
  // Paid engines — 1 credit each. All four non-Anthropic providers go
  // through the OpenAI-compatible adapter; base URLs are baked-in defaults
  // so the only env var per provider is the API key.
  backendAiProvider:
    process.env.BACKEND_AI_PROVIDER ?? process.env.AI_TEXT_PROVIDER ?? "openai",
  backendAiOpenaiModel:
    process.env.BACKEND_AI_OPENAI_MODEL ?? "gpt-5.5",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY ?? "",   // Qwen
  moonshotApiKey: process.env.MOONSHOT_API_KEY ?? "",     // Kimi
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  // DeepSeek retired `deepseek-chat` — GET /models now serves only
  // `deepseek-v4-flash` and `deepseek-v4-pro`, and calling the old alias
  // 400s ("The supported API model names are deepseek-v4-pro or
  // deepseek-v4-flash"). Flash matches this engine's "quick, lightweight
  // second opinion" billing; set DEEPSEEK_MODEL=deepseek-v4-pro to upgrade.
  deepseekModel: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
  zaiApiKey: process.env.ZAI_API_KEY ?? "",               // Z.AI / Zhipu GLM
  // GLM Coding Plan endpoint (monthly subscription). The standard
  // pay-as-you-go endpoint (.../api/paas/v4) returns 429 "insufficient
  // balance" unless the API wallet is topped up separately.
  zaiBaseUrl: process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4",
  perplexityApiKey: process.env.PERPLEXITY_API_KEY ?? "", // Sonar API
  // Sakana Fugu — orchestration model, OpenAI-compatible Chat Completions.
  // Base URL + model are env-overridable; defaults match Sakana's console
  // (https://api.sakana.ai/v1, model "fugu"; "fugu-ultra" is the higher tier).
  fuguApiKey: process.env.FUGU_API_KEY ?? "",
  fuguBaseUrl: process.env.FUGU_BASE_URL ?? "https://api.sakana.ai/v1",
  fuguModel: process.env.FUGU_MODEL ?? "fugu",
  // DataForSEO — keyword research for Autoblog. Basic-auth credentials.
  dataforseoLogin: process.env.DATAFORSEO_LOGIN ?? "",
  dataforseoPassword: process.env.DATAFORSEO_PASSWORD ?? "",
  // ValueSERP — powers CrawlProof Alerts (Google SERP polling). One API key;
  // billed per search. VALUESERP_LOCATION lets us pin a default geo.
  valueSerpApiKey: process.env.VALUESERP_API_KEY ?? "",
  valueSerpLocation: process.env.VALUESERP_LOCATION ?? "United States",
  // Alerts email sender. Kept separate from the transactional `resendFrom`
  // (audit reports/receipts): alert volume at scale can damage sender
  // reputation, so it rides its own warmed subdomain.
  alertsFrom: process.env.ALERTS_FROM ?? "CrawlProof Alerts <alerts@alerts.crawlproof.com>",
  // Social Posting — static AES-GCM key for at-rest token encryption.
  // 32 bytes base64-encoded. Generate via `openssl rand -base64 32`.
  // Phase 1 only; envelope encryption (Vault KEK + per-user DEKs)
  // replaces this when cookie + puppeteer modes ship.
  socialVaultKey: process.env.SOCIAL_VAULT_KEY ?? "",
  // Reddit OAuth — one app per Crawlproof env (web app type).
  // Register at https://www.reddit.com/prefs/apps with redirect
  // {siteUrl}/api/sp/oauth/reddit/callback.
  redditClientId: process.env.REDDIT_CLIENT_ID ?? "",
  redditClientSecret: process.env.REDDIT_CLIENT_SECRET ?? "",
  // User-Agent string sent on every Reddit API call. Reddit rejects
  // generic UAs ("Node-fetch/...") with 429; theirs is the only API
  // that genuinely cares.
  redditUserAgent:
    process.env.REDDIT_USER_AGENT ??
    "web:com.crawlproof.social:v1.0 (by /u/crawlproof)",
  // LinkedIn — "Sign In with LinkedIn using OpenID Connect" + "Share on
  // LinkedIn" products, both auto-enabled on a fresh dev app.
  // Register at https://www.linkedin.com/developers/apps with redirect
  // {siteUrl}/api/sp/oauth/linkedin/callback.
  linkedinClientId: process.env.LINKEDIN_CLIENT_ID ?? "",
  linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
  // X (Twitter) — OAuth2 with PKCE, confidential client. Requires a
  // paid X API tier ($200/mo Basic and up) for write access; the code
  // still compiles + the OAuth flow works on free, but POST /2/tweets
  // returns 403 until you upgrade.
  xClientId: process.env.X_CLIENT_ID ?? "",
  xClientSecret: process.env.X_CLIENT_SECRET ?? "",
  // Meta family — one OAuth app at developers.facebook.com covers
  // Facebook Pages, Instagram Business, and Threads. Different scopes
  // and endpoints, same app id/secret. Public use of `pages_manage_posts`
  // / `instagram_content_publish` needs Meta app review; works for the
  // app developer's own pages in dev mode pre-review.
  metaAppId: process.env.META_APP_ID ?? "",
  metaAppSecret: process.env.META_APP_SECRET ?? "",
  // Graph API version pin. Bump quarterly; Meta deprecates the oldest
  // version every ~2 years.
  metaGraphVersion: process.env.META_GRAPH_VERSION ?? "v21.0",
  // Threads has its own separate Meta app (different app id/secret).
  threadsAppId: process.env.THREADS_APP_ID ?? "",
  threadsAppSecret: process.env.THREADS_APP_SECRET ?? "",
  // Pinterest — OAuth2; /v5 API. Register at developers.pinterest.com.
  pinterestClientId: process.env.PINTEREST_CLIENT_ID ?? "",
  pinterestClientSecret: process.env.PINTEREST_CLIENT_SECRET ?? "",
  // TikTok — Content Posting API. Sandbox-only until TikTok's audit
  // approves your app for `video.publish` scope.
  tiktokClientKey: process.env.TIKTOK_CLIENT_KEY ?? "",
  tiktokClientSecret: process.env.TIKTOK_CLIENT_SECRET ?? "",
  // Google / YouTube — Google OAuth2 + YouTube Data API v3. The
  // default 6 uploads/day quota needs a raise request for prod use.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  // Pepper for SHA-256(token || pepper) on sp_api_token. A DB leak
  // alone cannot exploit any token without this server-side value.
  // Generate with `openssl rand -base64 32`.
  spTokenPepper: process.env.SP_TOKEN_PEPPER ?? "",
  // GitHub App — for connecting customer repos and opening automated PRs
  // (stats.js install, applying audit fixes). Register at
  // https://github.com/settings/apps with:
  //   Callback URL:  {siteUrl}/api/github/callback
  //   Webhook URL:   {siteUrl}/api/github/webhook   (optional, for later)
  //   Permissions:   Contents (Read & write), Pull requests (Read & write),
  //                  Metadata (Read-only)
  // GITHUB_APP_PRIVATE_KEY is the PEM-encoded RSA private key, NEWLINES
  // INCLUDED — paste with literal \n or upload the .pem and let Railway
  // expand it. GITHUB_APP_SLUG is the URL slug shown in the app's
  // GitHub URL (e.g. github.com/apps/<slug>); used to build install
  // links.
  githubAppId: process.env.GITHUB_APP_ID ?? "",
  githubAppClientId: process.env.GITHUB_APP_CLIENT_ID ?? "",
  githubAppClientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? "",
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
  githubAppSlug: process.env.GITHUB_APP_SLUG ?? "",
  required,
};
