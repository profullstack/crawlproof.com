function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  // CoinPay — crypto credit purchases.
  coinpayMerchantId: process.env.COINPAY_MERCHANT_ID ?? "",
  coinpayApiKey: process.env.COINPAY_API_KEY ?? "",
  coinpayApiUrl: process.env.COINPAY_API_URL ?? "https://coinpayportal.com/api",
  coinpayWebhookSecret: process.env.COINPAY_WEBHOOK_SECRET ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  resendFrom: process.env.RESEND_FROM ?? "CrawlProof <reports@crawlproof.com>",
  workerUrl: process.env.WORKER_URL ?? "",
  workerSecret: process.env.WORKER_SHARED_SECRET ?? "",
  cronSecret: process.env.CRON_SECRET ?? "",
  // Paid engines — 1 credit each. All four non-Anthropic providers go
  // through the OpenAI-compatible adapter; base URLs are baked-in defaults
  // so the only env var per provider is the API key.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY ?? "",   // Qwen
  moonshotApiKey: process.env.MOONSHOT_API_KEY ?? "",     // Kimi
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  perplexityApiKey: process.env.PERPLEXITY_API_KEY ?? "", // Sonar API
  // DataForSEO — keyword research for Autoblog. Basic-auth credentials.
  dataforseoLogin: process.env.DATAFORSEO_LOGIN ?? "",
  dataforseoPassword: process.env.DATAFORSEO_PASSWORD ?? "",
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
  required,
};
