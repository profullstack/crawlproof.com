import { serviceClient } from "@/lib/supabase/service";
import { decryptSecret, encryptSecret, canOpen } from "@/lib/sp/vault";
import { env } from "@/lib/env";
import {
  clearOperatorSecret,
  getOperatorSecret,
  noteOperatorLocked,
  operatorStatus,
  saveOperatorSecret,
} from "@/lib/sealed/operator";

const VU1NZ_PROVIDER = "vu1nz";
const VU1NZ_NAME = "website-scanner";
const VU1NZ_ENDPOINT = "https://vu1nz.com/api/v1/scan";

type IntegrationRow = {
  id: string;
  user_id: string | null;
  status: "enabled" | "disabled" | "error";
  config: Record<string, unknown> | null;
  encrypted_credentials: Record<string, unknown> | null;
  updated_at: string;
};

async function getVu1nzRow(): Promise<IntegrationRow | null> {
  const { data, error } = await serviceClient()
    .from("integrations")
    .select("id, user_id, status, config, encrypted_credentials, updated_at")
    .is("org_id", null)
    .eq("provider", VU1NZ_PROVIDER)
    .eq("name", VU1NZ_NAME)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return ((data ?? [])[0] as IntegrationRow | undefined) ?? null;
}

export async function getVu1nzIntegrationStatus() {
  const row = await getVu1nzRow();
  const encryptedToken = row?.encrypted_credentials?.api_token;
  return {
    configured: row?.status === "enabled" && typeof encryptedToken === "string" && encryptedToken.length > 0,
    status: row?.status ?? "disabled",
    updatedAt: row?.updated_at ?? null,
    endpoint:
      typeof row?.config?.endpoint === "string"
        ? row.config.endpoint
        : VU1NZ_ENDPOINT,
  };
}

export async function getVu1nzApiToken(): Promise<string | null> {
  const row = await getVu1nzRow();
  if (row?.status !== "enabled") return null;
  const encryptedToken = row.encrypted_credentials?.api_token;
  if (typeof encryptedToken !== "string" || !encryptedToken) return null;
  // Operator secret: sealed to the admin who saved it. While that admin is
  // locked the vu1nz engine is skipped (never crashes) and we raise the alert.
  if (!row.user_id || !canOpen(row.user_id)) {
    noteOperatorLocked("vu1nz scanner token");
    return null;
  }
  return decryptSecret(encryptedToken, { ownerId: row.user_id, field: "integrations.vu1nz.api_token" });
}

export async function saveVu1nzApiToken(input: {
  apiToken: string;
  userId: string;
}) {
  const token = input.apiToken.trim();
  if (!token) throw new Error("Vu1nz API token is required.");

  const encrypted = await encryptSecret(token, { ownerId: input.userId, field: "integrations.vu1nz.api_token" });
  const row = await getVu1nzRow();
  const payload = {
    user_id: input.userId,
    provider: VU1NZ_PROVIDER,
    direction: "outbound",
    name: VU1NZ_NAME,
    status: "enabled",
    config: {
      endpoint: VU1NZ_ENDPOINT,
      scan_type: "website",
    },
    encrypted_credentials: {
      api_token: encrypted,
    },
  };

  if (row) {
    const { error } = await serviceClient()
      .from("integrations")
      .update(payload)
      .eq("id", row.id);
    if (error) throw error;
    return;
  }

  const { error } = await serviceClient().from("integrations").insert({
    ...payload,
    org_id: null,
  });
  if (error) throw error;
}

export async function clearVu1nzApiToken(userId: string) {
  const row = await getVu1nzRow();
  const payload = {
    user_id: userId,
    provider: VU1NZ_PROVIDER,
    direction: "outbound",
    name: VU1NZ_NAME,
    status: "disabled",
    config: {
      endpoint: VU1NZ_ENDPOINT,
      scan_type: "website",
    },
    encrypted_credentials: {},
  };

  if (row) {
    const { error } = await serviceClient()
      .from("integrations")
      .update(payload)
      .eq("id", row.id);
    if (error) throw error;
    return;
  }

  const { error } = await serviceClient().from("integrations").insert({
    ...payload,
    org_id: null,
  });
  if (error) throw error;
}

const SMSHUB_PROVIDER = "smshub";
const SMSHUB_NAME = "outbound-sms";
const SMSHUB_ENDPOINT = "https://smshub.dev/api/v1/messages/send";
const COINPAY_PROVIDER = "coinpayportal";
const COINPAY_NAME = "crawlproof-billing";
const COINPAY_ENDPOINT = "https://coinpayportal.com";

async function getPlatformConnectionRow(provider: string, name: string): Promise<IntegrationRow | null> {
  const { data, error } = await serviceClient()
    .from("integrations")
    .select("id, user_id, status, config, encrypted_credentials, updated_at")
    .is("org_id", null)
    .eq("provider", provider)
    .eq("name", name)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? [])[0] as IntegrationRow | undefined) ?? null;
}

function rowConfig(row: IntegrationRow | null, key: string): string {
  const value = row?.config?.[key];
  return typeof value === "string" ? value : "";
}

async function savePlatformConnectionRow(input: {
  provider: string;
  name: string;
  direction: "outbound" | "bidirectional";
  userId: string;
  config: Record<string, string>;
}) {
  const row = await getPlatformConnectionRow(input.provider, input.name);
  const payload = {
    user_id: input.userId,
    provider: input.provider,
    direction: input.direction,
    name: input.name,
    status: "enabled",
    config: input.config,
    encrypted_credentials: {},
  };
  if (row) {
    const { error } = await serviceClient().from("integrations").update(payload).eq("id", row.id);
    if (error) throw error;
  } else {
    const { error } = await serviceClient().from("integrations").insert({ ...payload, org_id: null });
    if (error) throw error;
  }
}

async function disablePlatformConnectionRow(input: {
  provider: string;
  name: string;
  direction: "outbound" | "bidirectional";
  userId: string;
}) {
  const row = await getPlatformConnectionRow(input.provider, input.name);
  const payload = {
    user_id: input.userId,
    provider: input.provider,
    direction: input.direction,
    name: input.name,
    status: "disabled",
    config: {},
    encrypted_credentials: {},
  };
  if (row) {
    const { error } = await serviceClient().from("integrations").update(payload).eq("id", row.id);
    if (error) throw error;
  } else {
    const { error } = await serviceClient().from("integrations").insert({ ...payload, org_id: null });
    if (error) throw error;
  }
}

async function operatorKeyState(name: "SMSHUB_API_KEY" | "COINPAY_API_KEY") {
  return (await operatorStatus()).find((entry) => entry.name === name);
}

export async function getSmsHubConnection() {
  const row = await getPlatformConnectionRow(SMSHUB_PROVIDER, SMSHUB_NAME);
  const explicitlyDisabled = row?.status === "disabled";
  const [state, savedKey] = await Promise.all([
    operatorKeyState("SMSHUB_API_KEY"),
    explicitlyDisabled ? Promise.resolve(null) : getOperatorSecret("SMSHUB_API_KEY"),
  ]);
  const apiKey = explicitlyDisabled ? null : savedKey;
  const fromPhone = explicitlyDisabled ? "" : rowConfig(row, "from_phone") || env.smsHubFrom;
  const hasApiKey = !explicitlyDisabled && Boolean(state?.sealed || state?.envFallback);
  const locked = Boolean(state?.sealed && !state.unlocked);
  return {
    configured: hasApiKey && Boolean(fromPhone),
    hasApiKey,
    status: explicitlyDisabled ? "disabled" : locked ? "locked" : hasApiKey ? (fromPhone ? "enabled" : "needs_sender_phone") : "disabled",
    updatedAt: row?.updated_at ?? null,
    endpoint: SMSHUB_ENDPOINT,
    fromPhone,
    apiKey,
  };
}

export async function getSmsHubConnectionStatus() {
  const connection = await getSmsHubConnection();
  return {
    configured: connection.configured,
    hasApiKey: connection.hasApiKey,
    status: connection.status,
    updatedAt: connection.updatedAt,
    endpoint: connection.endpoint,
    fromPhone: connection.fromPhone,
  };
}

export async function listSmsHubSenderNumbers(input?: { apiKey?: string }) {
  const apiKey = input?.apiKey?.trim() || (await getOperatorSecret("SMSHUB_API_KEY"));
  if (!apiKey) throw new Error("Unlock operator keys or paste an SMSHub API key first.");
  const response = await fetch("https://smshub.dev/api/v1/numbers", {
    headers: { "X-API-Key": apiKey, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error("SMSHub rejected this API key.");
  if (!response.ok) throw new Error(`SMSHub sender lookup returned HTTP ${response.status}.`);
  const json = (await response.json().catch(() => null)) as
    | { numbers?: Array<{ number?: unknown; friendly_name?: unknown; status?: unknown }> }
    | null;
  const senders = (json?.numbers ?? [])
    .filter((item) => item.status === "active" && typeof item.number === "string" && item.number.trim())
    .map((item) => ({
      number: (item.number as string).trim(),
      label: typeof item.friendly_name === "string" && item.friendly_name.trim()
        ? item.friendly_name.trim()
        : (item.number as string).trim(),
    }));
  return senders;
}

export async function saveSmsHubConnection(input: { apiKey?: string; fromPhone?: string; userId: string }) {
  const row = await getPlatformConnectionRow(SMSHUB_PROVIDER, SMSHUB_NAME);
  const explicitKey = input.apiKey?.trim() ?? "";
  const state = await operatorKeyState("SMSHUB_API_KEY");
  const apiKey = explicitKey || (await getOperatorSecret("SMSHUB_API_KEY")) || "";
  const fromPhone = input.fromPhone?.trim() || rowConfig(row, "from_phone") || env.smsHubFrom;
  if (!apiKey) {
    throw new Error(state?.sealed ? "Unlock operator keys or paste a replacement SMSHub API key." : "SMSHub API key is required.");
  }
  if (!fromPhone) throw new Error("SMSHub sender phone is required.");

  const probe = await fetch(SMSHUB_ENDPOINT, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
  });
  const probeBody = (await probe.json().catch(() => null)) as { error?: string } | null;
  if (probe.status === 401) throw new Error("SMSHub rejected this API key.");
  const missingMessageFields = probeBody?.error?.match(/^Missing required fields:\s*(.*)$/i)?.[1]
    .split(/\s*,\s*/)
    .map((field) => field.toLowerCase()) ?? [];
  if (
    probe.status !== 400 ||
    !missingMessageFields.includes("to") ||
    !missingMessageFields.includes("message")
  ) {
    throw new Error(`SMSHub key check returned HTTP ${probe.status}.`);
  }

  if (explicitKey) await saveOperatorSecret("SMSHUB_API_KEY", explicitKey, input.userId);
  await savePlatformConnectionRow({
    provider: SMSHUB_PROVIDER,
    name: SMSHUB_NAME,
    direction: "outbound",
    userId: input.userId,
    config: { endpoint: SMSHUB_ENDPOINT, from_phone: fromPhone },
  });
}

export async function clearSmsHubConnection(userId: string) {
  await disablePlatformConnectionRow({ provider: SMSHUB_PROVIDER, name: SMSHUB_NAME, direction: "outbound", userId });
  await clearOperatorSecret("SMSHUB_API_KEY");
}

export async function getCoinPayPortalConnection() {
  const row = await getPlatformConnectionRow(COINPAY_PROVIDER, COINPAY_NAME);
  const explicitlyDisabled = row?.status === "disabled";
  const [state, savedKey] = await Promise.all([
    operatorKeyState("COINPAY_API_KEY"),
    explicitlyDisabled ? Promise.resolve(null) : getOperatorSecret("COINPAY_API_KEY"),
  ]);
  const apiKey = explicitlyDisabled ? null : savedKey;
  const merchantId = explicitlyDisabled ? "" : rowConfig(row, "merchant_id") || env.coinpayMerchantId;
  const apiUrl = explicitlyDisabled ? COINPAY_ENDPOINT : rowConfig(row, "api_url") || env.coinpayApiUrl || COINPAY_ENDPOINT;
  const webhookSecret = env.coinpayWebhookSecret;
  const hasApiKey = !explicitlyDisabled && Boolean(state?.sealed || state?.envFallback);
  const locked = Boolean(state?.sealed && !state.unlocked);
  return {
    configured: hasApiKey && Boolean(merchantId),
    hasApiKey,
    hasWebhookSecret: Boolean(webhookSecret),
    status: explicitlyDisabled ? "disabled" : locked ? "locked" : hasApiKey ? (merchantId ? "enabled" : "needs_business_id") : "disabled",
    updatedAt: row?.updated_at ?? null,
    apiKey,
    merchantId,
    apiUrl,
    webhookSecret,
  };
}

export async function getCoinPayPortalConnectionStatus() {
  const connection = await getCoinPayPortalConnection();
  return {
    configured: connection.configured,
    hasApiKey: connection.hasApiKey,
    hasWebhookSecret: connection.hasWebhookSecret,
    status: connection.status,
    updatedAt: connection.updatedAt,
    merchantId: connection.merchantId,
    apiUrl: connection.apiUrl,
  };
}

export async function saveCoinPayPortalConnection(input: {
  apiKey?: string;
  merchantId?: string;
  apiUrl?: string;
  userId: string;
}) {
  const row = await getPlatformConnectionRow(COINPAY_PROVIDER, COINPAY_NAME);
  const explicitKey = input.apiKey?.trim() ?? "";
  const state = await operatorKeyState("COINPAY_API_KEY");
  const apiKey = explicitKey || (await getOperatorSecret("COINPAY_API_KEY")) || "";
  const merchantId = input.merchantId?.trim() || rowConfig(row, "merchant_id") || env.coinpayMerchantId;
  const apiUrl = input.apiUrl?.trim() || rowConfig(row, "api_url") || env.coinpayApiUrl || COINPAY_ENDPOINT;
  if (!state?.sealed && !state?.envFallback && !apiKey) throw new Error("CoinPay Portal API key is required.");
  if (!merchantId) throw new Error("CoinPay Portal business ID is required.");
  const base = normalizeCoinPayApiBase(apiUrl);
  const parsedBase = new URL(base);
  if (parsedBase.protocol !== "https:" || parsedBase.hostname !== "coinpayportal.com") {
    throw new Error("CoinPay Portal API URL must use https://coinpayportal.com.");
  }
  if (apiKey) {
    const probe = await fetch(`${base}/api/supported-coins?active_only=true`, {
      headers: { authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!probe.ok) throw new Error(`CoinPay Portal rejected this key (HTTP ${probe.status}).`);
  } else if (!(state?.sealed && !state.unlocked)) {
    throw new Error("CoinPay Portal API key is not available.");
  }

  if (explicitKey) await saveOperatorSecret("COINPAY_API_KEY", explicitKey, input.userId);
  await savePlatformConnectionRow({
    provider: COINPAY_PROVIDER,
    name: COINPAY_NAME,
    direction: "bidirectional",
    userId: input.userId,
    config: { api_url: base, merchant_id: merchantId },
  });
}

export async function clearCoinPayPortalConnection(userId: string) {
  await disablePlatformConnectionRow({ provider: COINPAY_PROVIDER, name: COINPAY_NAME, direction: "bidirectional", userId });
  await clearOperatorSecret("COINPAY_API_KEY");
}

function normalizeCoinPayApiBase(value: string) {
  return value.replace(/\/+$/, "").replace(/\/api$/i, "");
}
