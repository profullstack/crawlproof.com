"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { encryptSecret, decryptSecret } from "@/lib/sp/vault";
import {
  createBlueskySession,
  createBlueskyPost,
  BLUESKY_MAX_CHARS,
} from "@/lib/sp/platforms/bluesky";
import {
  createRedditSelfPost,
  refreshRedditToken,
  REDDIT_TITLE_MAX,
  REDDIT_TEXT_MAX,
} from "@/lib/sp/platforms/reddit";
import {
  createMastodonStatus,
  MASTODON_DEFAULT_MAX_CHARS,
} from "@/lib/sp/platforms/mastodon";
import {
  getDiscordWebhookInfo,
  postDiscordWebhook,
  DISCORD_MAX_CHARS,
} from "@/lib/sp/platforms/discord";
import {
  getTelegramBotInfo,
  getTelegramChatInfo,
  sendTelegramMessage,
  validateTelegramToken,
  TELEGRAM_MAX_CHARS,
} from "@/lib/sp/platforms/telegram";
import {
  createLinkedinTextPost,
  LINKEDIN_MAX_CHARS,
} from "@/lib/sp/platforms/linkedin";
import {
  createTweet,
  refreshXToken,
  X_MAX_CHARS,
} from "@/lib/sp/platforms/x";
import {
  createFacebookPagePost,
  FACEBOOK_MAX_CHARS,
} from "@/lib/sp/platforms/facebook";
import {
  createThreadsPost,
  THREADS_MAX_CHARS,
} from "@/lib/sp/platforms/threads";

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
// connectDiscord — take a Discord channel webhook URL, validate it
// against Discord's API (GET on the URL returns webhook metadata),
// store the URL AES-GCM-encrypted in enc_access_token. handle =
// "<webhook-name> (#<channel-id>)" so the picker shows a human-readable
// label; external_id = the webhook id (stable across the webhook's
// lifetime; unique-conflict key with user_id+platform).
// ------------------------------------------------------------
export async function connectDiscord(input: {
  webhookUrl: string;
}): Promise<Ok<{ accountId: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const webhookUrl = (input.webhookUrl ?? "").trim();
  if (!webhookUrl) return { ok: false, error: "Paste a webhook URL." };

  let info;
  try {
    info = await getDiscordWebhookInfo(webhookUrl);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Discord webhook check failed.",
    };
  }

  const { data, error } = await supabase
    .from("sp_account")
    .upsert(
      {
        user_id: user.id,
        platform: "discord",
        auth_mode: "oauth", // webhook tokens behave like a bearer; reuse the column
        handle: info.displayHandle,
        external_id: info.id,
        enc_access_token: encryptSecret(webhookUrl),
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
// connectTelegram — take a bot token + channel reference, verify with
// getMe + getChat (which also confirms the bot has been added to the
// channel), then store. handle = "{channel-title} via @{bot-username}";
// external_id = numeric channel id as a string; enc_access_token =
// AES-GCM(bot token).
// ------------------------------------------------------------
export async function connectTelegram(input: {
  botToken: string;
  channel: string;
}): Promise<Ok<{ accountId: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  let token: string;
  try {
    token = validateTelegramToken(input.botToken ?? "");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Bad Telegram token.",
    };
  }

  let bot;
  try {
    bot = await getTelegramBotInfo(token);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Telegram bot check failed.",
    };
  }

  let chat;
  try {
    chat = await getTelegramChatInfo({ token, chatRef: input.channel ?? "" });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Telegram getChat failed.",
    };
  }

  const handle =
    `${chat.title} via @${bot.username}` +
    (chat.username ? "" : " (private)");

  const { data, error } = await supabase
    .from("sp_account")
    .upsert(
      {
        user_id: user.id,
        platform: "telegram",
        auth_mode: "oauth",
        handle,
        external_id: String(chat.id),
        enc_access_token: encryptSecret(token),
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
//
// Per-platform extras (subreddit + title for Reddit) ride along on the
// input shape — irrelevant for other platforms.
// ------------------------------------------------------------
export async function postNow(input: {
  accountId: string;
  text: string;
  subreddit?: string;
  title?: string;
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
      "id, platform, handle, external_id, instance_url, enc_access_token, enc_refresh_token, token_expires_at, status, consecutive_failures",
    )
    .eq("id", input.accountId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!account) return { ok: false, error: "Account not found." };
  if (account.status !== "active") {
    return { ok: false, error: `Account is ${account.status}.` };
  }
  if (!account.enc_access_token || !account.external_id) {
    return { ok: false, error: "Account has no stored token." };
  }

  // Per-platform input validation, before we touch sp_post.
  let title: string | null = null;
  let subreddit: string | null = null;
  if (account.platform === "bluesky") {
    if (text.length > BLUESKY_MAX_CHARS) {
      return {
        ok: false,
        error: `Bluesky posts max ${BLUESKY_MAX_CHARS} chars (got ${text.length}).`,
      };
    }
  } else if (account.platform === "reddit") {
    subreddit = (input.subreddit ?? "").trim().replace(/^\/?r\//, "");
    title = (input.title ?? "").trim();
    if (!subreddit) return { ok: false, error: "Pick a subreddit." };
    if (!title) return { ok: false, error: "Enter a post title." };
    if (title.length > REDDIT_TITLE_MAX) {
      return { ok: false, error: `Reddit title max ${REDDIT_TITLE_MAX} chars.` };
    }
    if (text.length > REDDIT_TEXT_MAX) {
      return { ok: false, error: `Reddit text body max ${REDDIT_TEXT_MAX} chars.` };
    }
  } else if (account.platform === "mastodon") {
    if (!account.instance_url) {
      return { ok: false, error: "Mastodon account is missing its instance URL." };
    }
    // Most instances default to 500. Some go higher; if the user tunes
    // their instance for longer toots they can raise this — for now we
    // enforce the conservative ceiling matching what we tell users.
    if (text.length > MASTODON_DEFAULT_MAX_CHARS) {
      return {
        ok: false,
        error: `Mastodon posts max ${MASTODON_DEFAULT_MAX_CHARS} chars (got ${text.length}).`,
      };
    }
  } else if (account.platform === "discord") {
    if (text.length > DISCORD_MAX_CHARS) {
      return {
        ok: false,
        error: `Discord messages max ${DISCORD_MAX_CHARS} chars (got ${text.length}).`,
      };
    }
  } else if (account.platform === "telegram") {
    if (text.length > TELEGRAM_MAX_CHARS) {
      return {
        ok: false,
        error: `Telegram messages max ${TELEGRAM_MAX_CHARS} chars (got ${text.length}).`,
      };
    }
  } else if (account.platform === "linkedin") {
    if (text.length > LINKEDIN_MAX_CHARS) {
      return {
        ok: false,
        error: `LinkedIn posts max ${LINKEDIN_MAX_CHARS} chars (got ${text.length}).`,
      };
    }
  } else if (account.platform === "x") {
    if (text.length > X_MAX_CHARS) {
      return {
        ok: false,
        error: `X posts max ${X_MAX_CHARS} chars (got ${text.length}).`,
      };
    }
  } else if (account.platform === "facebook_page") {
    if (text.length > FACEBOOK_MAX_CHARS) {
      return {
        ok: false,
        error: `Facebook posts max ${FACEBOOK_MAX_CHARS} chars (got ${text.length}).`,
      };
    }
  } else if (account.platform === "threads") {
    if (text.length > THREADS_MAX_CHARS) {
      return {
        ok: false,
        error: `Threads posts max ${THREADS_MAX_CHARS} chars (got ${text.length}).`,
      };
    }
  } else {
    return {
      ok: false,
      error: `Posting for ${account.platform} ships in a later phase.`,
    };
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

  let accessToken: string;
  try {
    accessToken = decryptSecret(account.enc_access_token);
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

  // Token refresh for the short-lived-token platforms. Both Reddit
  // (~1h tokens) and X (~2h tokens) ship a refresh_token grant; we
  // refresh proactively when within 60s of expiry. X rotates the
  // refresh_token on every refresh — we re-encrypt + persist whatever
  // the response gives us.
  const tokenNearExpiry =
    !!account.token_expires_at &&
    !!account.enc_refresh_token &&
    new Date(account.token_expires_at).getTime() - Date.now() < 60_000;
  if (tokenNearExpiry && (account.platform === "reddit" || account.platform === "x")) {
    try {
      const refreshToken = decryptSecret(account.enc_refresh_token);
      const fresh =
        account.platform === "reddit"
          ? await refreshRedditToken({ refreshToken })
          : await refreshXToken({ refreshToken });
      accessToken = fresh.accessToken;
      await supabase
        .from("sp_account")
        .update({
          enc_access_token: encryptSecret(fresh.accessToken),
          enc_refresh_token: fresh.refreshToken
            ? encryptSecret(fresh.refreshToken)
            : null,
          token_expires_at: fresh.expiresAt.toISOString(),
        })
        .eq("id", account.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Refresh failed.";
      await supabase
        .from("sp_post")
        .update({ status: "failed", last_error: message })
        .eq("id", row.id);
      await supabase
        .from("sp_account")
        .update({ status: "token_expired" })
        .eq("id", account.id);
      return {
        ok: false,
        error: `${account.platform} token refresh failed: ${message}`,
      };
    }
  }

  try {
    let result: { platformPostId: string; webUrl: string };
    if (account.platform === "bluesky") {
      const r = await createBlueskyPost({
        accessJwt: accessToken,
        did: account.external_id,
        handle: account.handle,
        text,
      });
      result = { platformPostId: r.uri, webUrl: r.webUrl };
    } else if (account.platform === "reddit") {
      const r = await createRedditSelfPost({
        accessToken,
        subreddit: subreddit!,
        title: title!,
        text,
      });
      result = { platformPostId: r.fullname, webUrl: r.webUrl };
    } else if (account.platform === "mastodon") {
      const r = await createMastodonStatus({
        instanceUrl: account.instance_url!,
        accessToken,
        status: text,
      });
      result = { platformPostId: r.id, webUrl: r.webUrl };
    } else if (account.platform === "discord") {
      // For Discord the decrypted "access token" is actually the
      // webhook URL.
      const r = await postDiscordWebhook({ webhookUrl: accessToken, text });
      result = { platformPostId: r.messageId, webUrl: r.webUrl };
    } else if (account.platform === "telegram") {
      const r = await sendTelegramMessage({
        token: accessToken,
        chatId: account.external_id,
        text,
      });
      result = {
        platformPostId: String(r.messageId),
        webUrl: r.webUrl,
      };
    } else if (account.platform === "linkedin") {
      const r = await createLinkedinTextPost({
        accessToken,
        memberSub: account.external_id,
        text,
      });
      result = { platformPostId: r.urn, webUrl: r.webUrl };
    } else if (account.platform === "x") {
      // account.handle is stored as "@username"; createTweet wants the
      // bare username for the permalink.
      const username = account.handle.replace(/^@/, "");
      const r = await createTweet({ accessToken, username, text });
      result = { platformPostId: r.tweetId, webUrl: r.webUrl };
    } else if (account.platform === "facebook_page") {
      const r = await createFacebookPagePost({
        pageId: account.external_id,
        pageAccessToken: accessToken,
        text,
      });
      result = { platformPostId: r.postId, webUrl: r.webUrl };
    } else {
      // account.platform === "threads" — narrowed above. external_id
      // is the Threads user id; handle is stored as "@username".
      const username = account.handle.replace(/^@/, "");
      const r = await createThreadsPost({
        accessToken,
        userId: account.external_id,
        username,
        text,
      });
      result = { platformPostId: r.threadId, webUrl: r.webUrl };
    }
    await supabase
      .from("sp_post")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        platform_post_id: result.platformPostId,
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
      .update({
        consecutive_failures: (account.consecutive_failures ?? 0) + 1,
      })
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
