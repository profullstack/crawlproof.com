// Test-only env. Must be set before any lib/env.ts import, so this file is
// listed under vitest.config.ts → setupFiles.
process.env.NEXT_PUBLIC_SITE_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://stub.supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "stub_anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stub_service";
process.env.COINPAY_MERCHANT_ID ??= "stub_merchant";
process.env.COINPAY_API_KEY ??= "stub_api_key";
process.env.COINPAY_API_URL ??= "https://stub.coinpayportal.com/api";
process.env.COINPAY_WEBHOOK_SECRET ??= "stub_webhook_secret";
process.env.WORKER_URL ??= "http://127.0.0.1:9080";
process.env.WORKER_SHARED_SECRET ??= "stub_worker_secret";
process.env.CRON_SECRET ??= "stub_cron_secret";
process.env.ANTHROPIC_API_KEY ??= "stub_anthropic";
process.env.RESEND_FROM ??= "Test <test@example.com>";
