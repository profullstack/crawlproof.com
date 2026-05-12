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
  // Paid engines (1 credit each).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  qwenApiKey: process.env.QWEN_API_KEY ?? "",
  qwenApiUrl:
    process.env.QWEN_API_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  kimiApiKey: process.env.KIMI_API_KEY ?? "",
  kimiApiUrl: process.env.KIMI_API_URL ?? "https://api.moonshot.ai/v1",
  required,
};
