"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { encryptSecret, decryptSecret } from "@/lib/sp/vault";
import { createBlueskySession } from "@/lib/sp/platforms/bluesky";
import {
  renderPostForPlatform,
  assemblePostText,
  type ProjectSocialConfig,
} from "@/lib/sp/renderPost";
import { getDiscordWebhookInfo } from "@/lib/sp/platforms/discord";
import {
  getTelegramBotInfo,
  getTelegramChatInfo,
  validateTelegramToken,
} from "@/lib/sp/platforms/telegram";
import { postViaAccount, type PostInput } from "@/lib/sp/post";
import { mintApiToken } from "@/lib/sp/apiToken";
import { serviceClient } from "@/lib/supabase/service";
import { processProjectSocialFeed, type FeedType } from "@/lib/sp/feedAutopost";
import { fetchSiteText, extractBrandProfile } from "@/lib/sp/brandProfileFetch";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// Reuse a single SDK instance across action invocations — these are
// stateless wrappers around fetch + a key.
const anthropicSdk = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const openaiSdk = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

type Ok<T = undefined> = { ok: true } & (T extends undefined ? {} : T);
type Err = { ok: false; error: string };
type FeedSettingsInput = {
  projectId: string;
  enabled: boolean;
  feedType: FeedType;
  feedUrl: string;
  ignorePaths: string;
  autopostAccountIds: string[];
};

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
        // Stored so the worker can silently re-auth when the Bluesky tokens
        // expire (Bluesky has no refresh-token rotation path here).
        enc_app_password: encryptSecret(appPassword),
        status: "active",
      },
      { onConflict: "user_id,platform,external_id" },
    )
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save account." };
  }

  revalidatePath("/projects", "layout");
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

  revalidatePath("/projects", "layout");
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

  revalidatePath("/projects", "layout");
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
  revalidatePath("/projects", "layout");
  return { ok: true };
}

// ------------------------------------------------------------
// createApiToken — mint a fresh sp_api_token for the signed-in user.
// Returns the plaintext token ONCE; we store only the hash. Caller is
// responsible for showing the user the token and warning them it
// won't be shown again.
// ------------------------------------------------------------
export async function createApiToken(input: {
  name: string;
}): Promise<Ok<{ id: string; token: string; prefix: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Give the token a name." };
  if (name.length > 80) return { ok: false, error: "Name too long." };

  let minted;
  try {
    minted = mintApiToken();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not mint token.",
    };
  }

  const { data, error } = await supabase
    .from("sp_api_token")
    .insert({
      user_id: user.id,
      name,
      prefix: minted.prefix,
      token_hash: minted.hash,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save token." };
  }

  revalidatePath("/projects", "layout");
  return { ok: true, id: data.id, token: minted.plaintext, prefix: minted.prefix };
}

// ------------------------------------------------------------
// revokeApiToken — mark a token as revoked (set revoked_at). Keeps the
// row for audit so the user sees what was revoked when.
// ------------------------------------------------------------
export async function revokeApiToken(tokenId: string): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("sp_api_token")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/projects", "layout");
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
export async function postNow(
  input: PostInput,
): Promise<Ok<{ postId: string; webUrl: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const result = await postViaAccount({
    supabase,
    userId: user.id,
    input,
    source: "manual",
  });
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath("/projects", "layout");
  return { ok: true, postId: result.postId, webUrl: result.webUrl };
}

export async function saveFeedAutopostSettings(
  input: FeedSettingsInput,
): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const projectId = (input.projectId ?? "").trim();
  if (!projectId) return { ok: false, error: "Project is missing." };
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  const feedType = input.feedType === "rss" ? "rss" : "sitemap";
  const feedUrl = (input.feedUrl ?? "").trim();
  if (feedUrl) {
    try {
      const parsed = new URL(feedUrl);
      if (!/^https?:$/.test(parsed.protocol)) {
        return { ok: false, error: "Feed URL must start with http:// or https://." };
      }
    } catch {
      return { ok: false, error: "Feed URL is not a valid URL." };
    }
  }

  const ignorePaths = parseIgnorePaths(input.ignorePaths);
  if (ignorePaths.length > 50) {
    return { ok: false, error: "Keep ignore paths to 50 or fewer." };
  }

  const requestedAccountIds = [...new Set(input.autopostAccountIds ?? [])];
  const { data: accounts, error: accountErr } = await supabase
    .from("sp_account")
    .select("id")
    .eq("user_id", user.id)
    .eq("status", "active");
  if (accountErr) return { ok: false, error: accountErr.message };

  const ownedAccountIds = new Set((accounts ?? []).map((a) => a.id as string));
  const autopostAccountIds = requestedAccountIds.filter((id) => ownedAccountIds.has(id));
  if (requestedAccountIds.length !== autopostAccountIds.length) {
    return { ok: false, error: "One selected social account was not found." };
  }

  const { error: feedErr } = await supabase
    .from("sp_feed_config")
    .upsert(
      {
        user_id: user.id,
        project_id: projectId,
        enabled: !!input.enabled,
        feed_type: feedType,
        feed_url: feedUrl || null,
        ignore_paths: ignorePaths,
        status: "idle",
        last_error: null,
      },
      { onConflict: "project_id" },
    );
  if (feedErr) return { ok: false, error: feedErr.message };

  const allOwnedIds = [...ownedAccountIds];
  if (allOwnedIds.length > 0) {
    const { error: offErr } = await supabase
      .from("sp_site_account")
      .update({ auto: false })
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .in("account_id", allOwnedIds);
    if (offErr) return { ok: false, error: offErr.message };
  }

  if (autopostAccountIds.length > 0) {
    const { error: bindErr } = await supabase.from("sp_site_account").upsert(
      autopostAccountIds.map((accountId) => ({
        user_id: user.id,
        project_id: projectId,
        account_id: accountId,
        auto: true,
        enabled: true,
      })),
      { onConflict: "project_id,account_id" },
    );
    if (bindErr) return { ok: false, error: bindErr.message };
  }

  revalidatePath(`/projects/${projectId}/social`);
  revalidatePath("/projects", "layout");
  return { ok: true };
}

export type SocialProfileInput = {
  projectId: string;
  brandVoice: string;
  tone: string;
  defaultHashtags: string;
  imageCadence: number;
  imageStyle: string;
  customInstructions: string;
};

const ALLOWED_TONES = new Set([
  "casual",
  "professional",
  "witty",
  "authoritative",
  "friendly",
  "playful",
  "technical",
]);

const ALLOWED_IMAGE_STYLES = new Set([
  "editorial",
  "infographic",
  "quote_card",
  "diagram",
  "screenshot",
  "rotate",
]);

export async function saveSocialProfile(
  input: SocialProfileInput,
): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const projectId = (input.projectId ?? "").trim();
  if (!projectId) return { ok: false, error: "Project is missing." };
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  const tone = ALLOWED_TONES.has(input.tone) ? input.tone : "casual";
  const imageStyle = ALLOWED_IMAGE_STYLES.has(input.imageStyle)
    ? input.imageStyle
    : "editorial";
  const brandVoice = (input.brandVoice ?? "").trim().slice(0, 2000);
  const customInstructions = (input.customInstructions ?? "").trim().slice(0, 2000);
  const hashtagList = (input.defaultHashtags ?? "")
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => (h.startsWith("#") ? h : `#${h}`))
    .slice(0, 12);
  const cadenceRaw = Number.isFinite(input.imageCadence) ? input.imageCadence : 0;
  const imageCadence = Math.max(0, Math.min(50, Math.round(cadenceRaw)));

  const { error: upErr } = await (supabase as any)
    .from("sp_project_config")
    .upsert(
      {
        project_id: projectId,
        user_id: user.id,
        brand_voice: brandVoice,
        tone,
        default_hashtags: hashtagList,
        image_cadence: imageCadence,
        image_style: imageStyle,
        custom_instructions: customInstructions,
      },
      { onConflict: "project_id" },
    );
  if (upErr) return { ok: false, error: upErr.message };
  revalidatePath(`/projects/${projectId}/social`);
  return { ok: true };
}

/**
 * Use AI to derive a brand profile from the project's website. Returns the
 * fields shaped like SocialProfileInput so the form can populate itself; it
 * does NOT persist — the user reviews and clicks Save (saveSocialProfile).
 */
export async function fetchBrandProfile(input: {
  projectId: string;
}): Promise<{ ok: true; data: SocialProfileInput } | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const projectId = (input.projectId ?? "").trim();
  if (!projectId) return { ok: false, error: "Project is missing." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, url, name")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  const url = ((project as { url?: string }).url ?? "").trim();
  if (!url) {
    return { ok: false, error: "Add a website URL to this project first." };
  }

  try {
    const { title, text } = await fetchSiteText(url);
    if (!text) {
      return {
        ok: false,
        error: "Couldn't read any content from the site. Check the project URL.",
      };
    }
    const extracted = await extractBrandProfile({
      url,
      name: (project as { name?: string | null }).name ?? null,
      title,
      siteText: text,
    });
    return {
      ok: true,
      data: {
        projectId,
        brandVoice: extracted.brandVoice,
        tone: extracted.tone,
        defaultHashtags: extracted.defaultHashtags.join(" "),
        imageCadence: extracted.imageCadence,
        imageStyle: extracted.imageStyle,
        customInstructions: extracted.customInstructions,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to fetch brand info.",
    };
  }
}

export async function checkSocialFeedNow(
  projectId: string,
): Promise<Ok<FeedProcessResultShape> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  const result = await processProjectSocialFeed(serviceClient(), projectId, {
    clients: { anthropic: anthropicSdk, openai: openaiSdk },
  });
  revalidatePath(`/projects/${projectId}/social`);
  if (!result.ok) return { ok: false, error: result.error ?? "Feed check failed." };
  return {
    ok: true,
    checked: result.checked ?? 0,
    newItems: result.newItems ?? 0,
    posted: result.posted ?? 0,
    seeded: result.seeded ?? 0,
    ignored: result.ignored ?? 0,
  };
}

type FeedProcessResultShape = {
  checked: number;
  newItems: number;
  posted: number;
  seeded: number;
  ignored: number;
};

function parseIgnorePaths(input: string): string[] {
  const seen = new Set<string>();
  for (const raw of input.split(/[\n,]/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let path = trimmed;
    try {
      path = new URL(trimmed).pathname;
    } catch {
      path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    }
    path = path.replace(/\/+$/, "") || "/";
    if (path.length <= 200) seen.add(path);
  }
  return [...seen];
}

// ------------------------------------------------------------
// getBlueskyAppPassword — owner-gated reveal of the stored app
// password for the accounts UI (Show/Copy). Returns the decrypted value.
// ------------------------------------------------------------
export async function getBlueskyAppPassword(input: {
  accountId: string;
}): Promise<Ok<{ appPassword: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: account } = await supabase
    .from("sp_account")
    .select("id, enc_app_password")
    .eq("id", input.accountId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!account) return { ok: false, error: "Account not found." };
  const enc = (account as { enc_app_password?: string | null }).enc_app_password;
  if (!enc) {
    return { ok: false, error: "No app password stored — reconnect to save it." };
  }
  try {
    return { ok: true, appPassword: decryptSecret(enc) };
  } catch {
    return { ok: false, error: "Could not decrypt the stored app password." };
  }
}

// ------------------------------------------------------------
// postNowFromUrl — AI-render an article URL per-platform using the
// project's brand profile and post immediately to the chosen accounts.
// ------------------------------------------------------------
export async function postNowFromUrl(input: {
  projectId: string;
  url: string;
  accountIds: string[];
}): Promise<Ok<{ posted: number; errors: string[] }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const projectId = (input.projectId ?? "").trim();
  const url = (input.url ?? "").trim();
  const accountIds = (input.accountIds ?? []).filter(Boolean);
  if (!projectId) return { ok: false, error: "Project is missing." };
  if (!url) return { ok: false, error: "Enter an article URL." };
  try {
    const p = new URL(url);
    if (!/^https?:$/.test(p.protocol)) {
      return { ok: false, error: "URL must start with http:// or https://." };
    }
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
  if (accountIds.length === 0) {
    return { ok: false, error: "Pick at least one account." };
  }

  // Project ownership (RLS scopes it) + brand profile.
  const { data: cfgRow } = await supabase
    .from("sp_project_config")
    .select("brand_voice, tone, default_hashtags, custom_instructions")
    .eq("project_id", projectId)
    .maybeSingle();
  const config: ProjectSocialConfig = {
    brand_voice: (cfgRow?.brand_voice as string | null) ?? "",
    tone: (cfgRow?.tone as string | null) ?? "casual",
    default_hashtags: (cfgRow?.default_hashtags as string[] | null) ?? [],
    custom_instructions: (cfgRow?.custom_instructions as string | null) ?? "",
  };

  const { data: accounts } = await supabase
    .from("sp_account")
    .select("id, platform")
    .eq("user_id", user.id)
    .in("id", accountIds);
  if (!accounts || accounts.length === 0) {
    return { ok: false, error: "No matching accounts." };
  }

  // Fetch the real page title so the render has good input.
  let title: string | null = null;
  try {
    const site = await fetchSiteText(url);
    title = site.title || null;
  } catch {
    // non-fatal — render can derive from the URL
  }

  let posted = 0;
  const errors: string[] = [];
  for (const account of accounts as Array<{ id: string; platform: string }>) {
    try {
      const rendered = await renderPostForPlatform({
        anthropic: anthropicSdk,
        openai: openaiSdk,
        platform: account.platform,
        url,
        articleTitle: title,
        config,
      });
      const text = assemblePostText({ rendered, url, platform: account.platform });
      const result = await postViaAccount({
        supabase,
        userId: user.id,
        input: { accountId: account.id, text, title: rendered.title },
        source: "manual",
        projectId,
      });
      if (result.ok) posted++;
      else errors.push(`${account.platform}: ${result.error}`);
    } catch (err) {
      errors.push(
        `${account.platform}: ${err instanceof Error ? err.message : "render failed"}`,
      );
    }
  }

  revalidatePath(`/projects/${projectId}/social`);
  if (posted === 0) {
    return { ok: false, error: errors.join("; ") || "Nothing was posted." };
  }
  return { ok: true, posted, errors };
}

// ------------------------------------------------------------
// retryPost — re-publish a previously failed post using its stored
// rendered_text + account. Owner-gated.
// ------------------------------------------------------------
export async function retryPost(input: {
  postId: string;
}): Promise<Ok<{ webUrl: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: post } = await supabase
    .from("sp_post")
    .select("id, account_id, rendered_text, status, project_id")
    .eq("id", input.postId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!post) return { ok: false, error: "Post not found." };
  const p = post as {
    account_id: string;
    rendered_text: string | null;
    project_id: string | null;
  };
  if (!p.account_id || !p.rendered_text) {
    return { ok: false, error: "This post can't be retried (missing account or text)." };
  }

  const result = await postViaAccount({
    supabase,
    userId: user.id,
    input: { accountId: p.account_id, text: p.rendered_text },
    source: "manual",
    projectId: p.project_id ?? undefined,
  });
  if (!result.ok) return { ok: false, error: result.error };
  if (p.project_id) revalidatePath(`/projects/${p.project_id}/social`);
  return { ok: true, webUrl: result.webUrl };
}
