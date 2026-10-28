import { serviceClient } from "@/lib/supabase/service";
import { decryptSecret, encryptSecret, canOpen } from "@/lib/sp/vault";
import { noteOperatorLocked } from "@/lib/sealed/operator";

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
