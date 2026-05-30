// postViaAccount — the pure dispatcher behind both the /social server
// action and the /api/sp/v1/posts HTTP endpoint. Takes a Supabase
// client + the authenticated user id + the post input; does NOT touch
// revalidatePath (that's the caller's concern).
//
// The same function used to live inline in app/actions/socialPosting.ts.
// Extracted so the v1 API can call it without depending on next/cache.

import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSecret, decryptSecret } from "@/lib/sp/vault";
import {
  createBlueskyPost,
  createBlueskySession,
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
  postDiscordWebhook,
  DISCORD_MAX_CHARS,
} from "@/lib/sp/platforms/discord";
import {
  sendTelegramMessage,
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

export type PostSource = "manual" | "api" | "autoblog" | "rss" | "sitemap";

export type PostInput = {
  accountId: string;
  text: string;
  subreddit?: string;
  title?: string;
  // Public URLs of images/media to attach. v1 only persists this on
  // sp_post.rendered_media_url — per-platform attachment uploads (Bluesky
  // embeds, X media_id, Mastodon attachments) ship as each platform
  // module learns to handle the field. Until then, the URL is included
  // in the post text by the renderer so the link unfurls.
  mediaUrl?: string[];
};

export type PostOk = {
  ok: true;
  postId: string;
  webUrl: string;
  platformPostId: string;
};
export type PostErr = { ok: false; error: string };
export type PostResult = PostOk | PostErr;

// supabase: any user-scoped client (Server-Component client OR
// service-role client where RLS isn't relevant). We pass userId
// explicitly so the v1 API path can use a service-role client
// (no auth.uid()) and still scope writes properly.
export async function postViaAccount(args: {
  supabase: SupabaseClient<any>;
  userId: string;
  input: PostInput;
  source: PostSource;
  projectId?: string | null;
}): Promise<PostResult> {
  const { supabase, userId, input, source, projectId } = args;

  const text = (input.text ?? "").trim();
  if (!text) return { ok: false, error: "Enter some text." };

  const { data: account } = await supabase
    .from("sp_account")
    .select(
      "id, platform, handle, external_id, instance_url, enc_access_token, enc_refresh_token, enc_app_password, token_expires_at, status, consecutive_failures",
    )
    .eq("id", input.accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!account) return { ok: false, error: "Account not found." };
  if (account.status !== "active") {
    return { ok: false, error: `Account is ${account.status}.` };
  }
  if (!account.enc_access_token || !account.external_id) {
    return { ok: false, error: "Account has no stored token." };
  }

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

  const { data: row, error: insErr } = await supabase
    .from("sp_post")
    .insert({
      user_id: userId,
      account_id: account.id,
      project_id: projectId ?? null,
      source,
      rendered_text: text,
      rendered_media_url: input.mediaUrl ?? [],
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

  // Refresh Reddit (~1h) and X (~2h) tokens that are about to expire.
  // Both rotate refresh_token on refresh in some cases; persist
  // whatever the response gives us.
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
      const doPost = (jwt: string) =>
        createBlueskyPost({
          accessJwt: jwt,
          did: account.external_id,
          handle: account.handle,
          text,
        });
      let r;
      try {
        r = await doPost(accessToken);
      } catch (err) {
        // Bluesky access JWTs expire and there's no refresh path; if we
        // stored the app password, re-auth and retry once.
        if (!account.enc_app_password) throw err;
        const appPassword = decryptSecret(account.enc_app_password);
        const session = await createBlueskySession({
          handle: account.handle,
          appPassword,
        });
        await supabase
          .from("sp_account")
          .update({
            enc_access_token: encryptSecret(session.accessJwt),
            enc_refresh_token: encryptSecret(session.refreshJwt),
            status: "active",
          })
          .eq("id", account.id);
        r = await doPost(session.accessJwt);
      }
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
      const r = await postDiscordWebhook({ webhookUrl: accessToken, text });
      result = { platformPostId: r.messageId, webUrl: r.webUrl };
    } else if (account.platform === "telegram") {
      const r = await sendTelegramMessage({
        token: accessToken,
        chatId: account.external_id,
        text,
      });
      result = { platformPostId: String(r.messageId), webUrl: r.webUrl };
    } else if (account.platform === "linkedin") {
      const r = await createLinkedinTextPost({
        accessToken,
        memberSub: account.external_id,
        text,
      });
      result = { platformPostId: r.urn, webUrl: r.webUrl };
    } else if (account.platform === "x") {
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
      // threads
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
    return {
      ok: true,
      postId: row.id,
      webUrl: result.webUrl,
      platformPostId: result.platformPostId,
    };
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
