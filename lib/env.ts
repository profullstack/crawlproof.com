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
  required,
};
