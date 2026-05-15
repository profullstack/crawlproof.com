"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { encryptSecret, decryptSecret } from "@/lib/sp/vault";
import {
  createBlueskySession,
  createBlueskyPost,
  BLUESKY_MAX_CHARS,
} from "@/lib/sp/platforms/bluesky";

type Ok<T = undefined> = { ok: true } & (T extends undefined ? {} : T);
type Err = { ok: false; error: string };

// ------------------------------------------------------------
// connectBluesky — trade handle + app password for a session,
// store encrypted JWTs in sp_account. Caller stays on /social/setup
// and re-renders the connected-accounts list.
// ------------------------------------------------------------
export async function connectBluesky(input: {
  handle: string;
  appPassword: string;
}): Promise<Ok<{ accountId: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const handle = (input.handle ?? "").trim().replace(/^@/, "");
  const appPassword = (input.appPassword ?? "").trim();
  if (!handle) return { ok: false, error: "Enter your Bluesky handle." };
  if (!appPassword) return { ok: false, error: "Enter an app password." };
  // Bluesky app passwords are formatted xxxx-xxxx-xxxx-xxxx but
  // they're tolerant of other lengths; minimal sanity check only.
  if (appPassword.length < 12 || appPassword.length > 200) {
    return { ok: false, error: "App password looks malformed." };
  }

  let session;
  try {
    session = await createBlueskySession({ handle, appPassword });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Bluesky auth failed.",
    };
  }

  // Idempotent upsert keyed on (user, platform, external_id=did).
  const { data, error } = await supabase
    .from("sp_account")
    .upsert(
      {
        user_id: user.id,
        platform: "bluesky",
        auth_mode: "oauth",
        handle: session.handle,
        external_id: session.did,
        enc_access_token: encryptSecret(session.accessJwt),
        enc_refresh_token: encryptSecret(session.refreshJwt),
        status: "active",
      },
      { onConflict: "user_id,platform,external_id" },
    )
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save account." };
  }

  revalidatePath("/social");
  revalidatePath("/social/setup");
  return { ok: true, accountId: data.id };
}

// ------------------------------------------------------------
// disconnectAccount — delete an sp_account row (RLS scopes to owner).
// Cascades to sp_site_account + sp_post via the FK constraints.
// ------------------------------------------------------------
export async function disconnectAccount(
  accountId: string,
): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("sp_account")
    .delete()
    .eq("id", accountId)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/social");
  revalidatePath("/social/setup");
  return { ok: true };
}

// ------------------------------------------------------------
// postNow — synchronous "post this text right now to this account."
// v1 Phase 1: ignores scheduling, no worker, no queue. The full
// scheduled-publish path lands when we wire the worker tick.
// ------------------------------------------------------------
export async function postNow(input: {
  accountId: string;
  text: string;
}): Promise<Ok<{ postId: string; webUrl: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const text = (input.text ?? "").trim();
  if (!text) return { ok: false, error: "Enter some text." };

  const { data: account } = await supabase
    .from("sp_account")
    .select(
      "id, platform, handle, external_id, enc_access_token, enc_refresh_token, status",
    )
    .eq("id", input.accountId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!account) return { ok: false, error: "Account not found." };
  if (account.status !== "active") {
    return { ok: false, error: `Account is ${account.status}.` };
  }

  // Phase 1 only supports Bluesky.
  if (account.platform !== "bluesky") {
    return {
      ok: false,
      error: `Posting for ${account.platform} ships in a later phase.`,
    };
  }
  if (text.length > BLUESKY_MAX_CHARS) {
    return {
      ok: false,
      error: `Bluesky posts max ${BLUESKY_MAX_CHARS} chars (got ${text.length}).`,
    };
  }
  if (!account.enc_access_token || !account.external_id) {
    return { ok: false, error: "Account has no stored token." };
  }

  // Write the sp_post row in 'publishing' state up front so the post
  // is visible in the dashboard even if the HTTP call hangs.
  const { data: row, error: insErr } = await supabase
    .from("sp_post")
    .insert({
      user_id: user.id,
      account_id: account.id,
      source: "manual",
      rendered_text: text,
      scheduled_for: new Date().toISOString(),
      status: "publishing",
      publish_attempts: 1,
    })
    .select("id")
    .single();
  if (insErr || !row) {
    return { ok: false, error: insErr?.message ?? "Could not queue post." };
  }

  let accessJwt: string;
  try {
    accessJwt = decryptSecret(account.enc_access_token);
  } catch (err) {
    await supabase
      .from("sp_post")
      .update({
        status: "failed",
        last_error: "decrypt failed: " + (err instanceof Error ? err.message : "?"),
      })
      .eq("id", row.id);
    return { ok: false, error: "Stored token could not be decrypted." };
  }

  try {
    const result = await createBlueskyPost({
      accessJwt,
      did: account.external_id,
      handle: account.handle,
      text,
    });
    await supabase
      .from("sp_post")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        platform_post_id: result.uri,
        platform_post_url: result.webUrl,
      })
      .eq("id", row.id);
    await supabase
      .from("sp_account")
      .update({ last_post_at: new Date().toISOString(), consecutive_failures: 0 })
      .eq("id", account.id);
    await supabase.from("sp_publish_attempt").insert({
      post_id: row.id,
      attempt_number: 1,
      outcome: "success",
      http_status: 200,
      auth_mode: "oauth",
    });
    revalidatePath("/social");
    return { ok: true, postId: row.id, webUrl: result.webUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await supabase
      .from("sp_post")
      .update({ status: "failed", last_error: message })
      .eq("id", row.id);
    await supabase
      .from("sp_account")
      .update({ consecutive_failures: (account as any).consecutive_failures + 1 || 1 })
      .eq("id", account.id);
    await supabase.from("sp_publish_attempt").insert({
      post_id: row.id,
      attempt_number: 1,
      outcome: "permanent_fail",
      error_message: message,
      auth_mode: "oauth",
    });
    return { ok: false, error: message };
  }
}
