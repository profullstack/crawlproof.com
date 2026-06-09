"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import {
  clearVu1nzApiToken,
  getVu1nzApiToken,
  saveVu1nzApiToken,
} from "@/lib/platform-integrations";

type Ok<T = undefined> = { ok: true } & (T extends undefined ? {} : T);
type Err = { ok: false; error: string };

const MAX_REASON_LEN = 280;
const MIN_GRANT = 1;
const MAX_GRANT = 10_000;

// Verify the caller is_admin via the user-scoped client (subject to
// RLS — they can only read their own profile, so this is a self-check
// that can't be spoofed).
async function assertAdmin(): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.is_admin) return { ok: false, error: "Admin only." };
  return { ok: true, userId: user.id };
}

// Grant credits to a user by email. Positive `credits` adds; negative
// removes (so admins can also revoke). Every grant lands in
// admin_credit_grants for the audit trail.
export async function grantCredits(input: {
  email: string;
  credits: number;
  reason?: string;
}): Promise<Ok<{ recipientId: string; newBalance: number }> | Err> {
  const adminCheck = await assertAdmin();
  if (!adminCheck.ok) return adminCheck;

  const email = (input.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { ok: false, error: "Enter a valid email." };
  }
  const credits = Math.trunc(input.credits ?? 0);
  if (!Number.isFinite(credits) || credits === 0) {
    return { ok: false, error: "Credits must be a non-zero integer." };
  }
  if (Math.abs(credits) > MAX_GRANT) {
    return { ok: false, error: `Limit is ±${MAX_GRANT} per grant.` };
  }
  if (credits > 0 && credits < MIN_GRANT) {
    return { ok: false, error: `Minimum positive grant is ${MIN_GRANT}.` };
  }
  const reason = (input.reason || "").trim().slice(0, MAX_REASON_LEN) || null;

  // Service-role writes — profiles + admin_credit_grants both need to
  // update without the user owning the recipient.
  const svc = serviceClient();

  const { data: recipient, error: rErr } = await svc
    .from("profiles")
    .select("id, email, credits_balance")
    .ilike("email", email)
    .maybeSingle();
  if (rErr) return { ok: false, error: rErr.message };
  if (!recipient) return { ok: false, error: `No user with email ${email}.` };

  const newBalance = (recipient.credits_balance ?? 0) + credits;
  if (newBalance < 0) {
    return {
      ok: false,
      error: `Cannot remove ${Math.abs(credits)} credits — user only has ${recipient.credits_balance}.`,
    };
  }

  const { error: upErr } = await svc
    .from("profiles")
    .update({ credits_balance: newBalance })
    .eq("id", recipient.id);
  if (upErr) return { ok: false, error: upErr.message };

  const { error: auditErr } = await svc.from("admin_credit_grants").insert({
    granted_by: adminCheck.userId,
    recipient_id: recipient.id,
    recipient_email: recipient.email ?? email,
    credits,
    reason,
  });
  if (auditErr) {
    // Audit row failed but balance already changed — surface it so
    // we don't pretend the grant is fully logged.
    return {
      ok: false,
      error: `Balance updated but audit insert failed: ${auditErr.message}`,
    };
  }

  revalidatePath("/admin");
  return { ok: true, recipientId: recipient.id, newBalance };
}

export async function saveVu1nzIntegration(input: {
  apiToken?: string;
  clear?: boolean;
}): Promise<Ok | Err> {
  const adminCheck = await assertAdmin();
  if (!adminCheck.ok) return adminCheck;

  try {
    if (input.clear) {
      await clearVu1nzApiToken(adminCheck.userId);
    } else {
      const apiToken = (input.apiToken ?? "").trim();
      if (!apiToken) {
        return { ok: false, error: "Paste the Vu1nz API token first." };
      }
      await saveVu1nzApiToken({ apiToken, userId: adminCheck.userId });
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save Vu1nz integration.",
    };
  }

  revalidatePath("/admin");
  return { ok: true };
}

export async function revealVu1nzIntegrationToken(): Promise<
  Ok<{ apiToken: string }> | Err
> {
  const adminCheck = await assertAdmin();
  if (!adminCheck.ok) return adminCheck;

  try {
    const apiToken = await getVu1nzApiToken();
    if (!apiToken) {
      return { ok: false, error: "Vu1nz API token is not configured." };
    }
    return { ok: true, apiToken };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not reveal Vu1nz API token.",
    };
  }
}
