// Worker-side processor for browser-automated posts (auth_mode='cookie').
// Called from worker/index.ts — has access to Playwright (Chromium).
//
// Flow:
//   1. Load sp_post + sp_account for the postId.
//   2. Decrypt cookies from enc_access_token.
//   3. If platform needs an image and none was supplied, generate one via
//      gpt-image-1 using the account's image_style preference.
//   4. Dispatch to the platform-specific browser function.
//   5. Update sp_post with success/failure.

import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { decryptSecret } from "@/lib/sp/vault";
import {
  parseCookies,
  redditBrowserPost,
  facebookBrowserPost,
  threadsBrowserPost,
  instagramBrowserPost,
  xBrowserPost,
  linkedinBrowserPost,
  mastodonBrowserPost,
} from "@/lib/sp/platforms/browser";
import {
  generateSocialImage,
  uploadSocialImage,
  resolveImageStyle,
  type ImageStyle,
  type ImageStylePref,
} from "@/lib/sp/imageGen";

export async function processBrowserPost(args: {
  postId: string;
  supabase: SupabaseClient<any>;
  openai: OpenAI | null;
}): Promise<void> {
  const { postId, supabase, openai } = args;

  // Claim the row atomically.
  const { data: claimed } = await supabase
    .from("sp_post")
    .update({ status: "publishing" })
    .eq("id", postId)
    .eq("status", "queued_browser")
    .select("id, account_id, rendered_text, rendered_media_url, subreddit, title")
    .maybeSingle();
  if (!claimed) {
    console.log(`[browser-post] ${postId} already picked up or not found`);
    return;
  }

  const { data: account } = await supabase
    .from("sp_account")
    .select("id, platform, handle, external_id, enc_access_token, image_style, instance_url, user_id")
    .eq("id", claimed.account_id)
    .maybeSingle();
  if (!account?.enc_access_token) {
    await fail(supabase, postId, account?.id, "Account not found or missing cookies.");
    return;
  }

  let cookies;
  try {
    const raw = decryptSecret(account.enc_access_token);
    cookies = parseCookies(raw);
  } catch (err) {
    await fail(supabase, postId, account.id, `Cookie decrypt failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const text: string = claimed.rendered_text ?? "";
  const mediaUrls: string[] = claimed.rendered_media_url ?? [];
  let imageUrl: string | undefined = mediaUrls[0];

  // Generate an image when the platform requires one (Instagram) or the
  // account has an image_style set and no image was supplied.
  const needsImage = account.platform === "instagram";
  const wantsImage = account.image_style && account.image_style !== "none";
  if ((needsImage || wantsImage) && !imageUrl && openai) {
    try {
      const style = resolveImageStyle(
        (account.image_style ?? "editorial") as ImageStylePref,
        postId,
      );
      const bytes = await generateSocialImage({
        openai,
        articleTitle: (claimed.title as string | null) ?? text.slice(0, 120),
        brandVoice: "",
        style: style as ImageStyle,
      });
      if (bytes) {
        const url = await uploadSocialImage(supabase, postId, bytes, "image/png");
        if (url) imageUrl = url;
      }
    } catch (err) {
      console.warn(`[browser-post] image gen failed for ${postId}`, err);
      if (needsImage) {
        await fail(supabase, postId, account.id, "Image generation required but failed.");
        return;
      }
    }
  }
  if (needsImage && !imageUrl) {
    await fail(supabase, postId, account.id, "Instagram requires an image; image generation failed or no image supplied.");
    return;
  }

  try {
    let result: { platformPostId: string; webUrl: string };

    if (account.platform === "reddit") {
      const subreddit = (claimed.subreddit as string | null) ?? "";
      const title = (claimed.title as string | null) ?? text.slice(0, 300);
      if (!subreddit) throw new Error("Subreddit is required for Reddit posts.");
      result = await redditBrowserPost({ cookies, subreddit, title, text });
    } else if (account.platform === "facebook_page") {
      result = await facebookBrowserPost({
        cookies,
        pageId: account.external_id,
        text,
        imageUrl,
      });
    } else if (account.platform === "threads") {
      result = await threadsBrowserPost({ cookies, text, imageUrl });
    } else if (account.platform === "instagram") {
      result = await instagramBrowserPost({
        cookies,
        caption: text,
        imageUrl: imageUrl!,
      });
    } else if (account.platform === "x") {
      result = await xBrowserPost({ cookies, text, imageUrl });
    } else if (account.platform === "linkedin") {
      result = await linkedinBrowserPost({ cookies, text, imageUrl });
    } else if (account.platform === "mastodon") {
      const instanceUrl = account.instance_url ?? "mastodon.social";
      result = await mastodonBrowserPost({ cookies, instanceUrl, text, imageUrl });
    } else {
      throw new Error(`Browser posting not implemented for platform: ${account.platform}`);
    }

    await supabase
      .from("sp_post")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        platform_post_id: result.platformPostId,
        platform_post_url: result.webUrl,
      })
      .eq("id", postId);
    await supabase
      .from("sp_account")
      .update({ last_post_at: new Date().toISOString(), consecutive_failures: 0 })
      .eq("id", account.id);
    await supabase.from("sp_publish_attempt").insert({
      post_id: postId,
      attempt_number: 1,
      outcome: "success",
      http_status: 200,
      auth_mode: "cookie",
    });
    console.log(`[browser-post] ${postId} published to ${account.platform} → ${result.webUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await fail(supabase, postId, account.id, message);
  }
}

async function fail(
  supabase: SupabaseClient<any>,
  postId: string,
  accountId: string | undefined,
  message: string,
): Promise<void> {
  console.error(`[browser-post] ${postId} failed: ${message}`);
  await supabase
    .from("sp_post")
    .update({ status: "failed", last_error: message })
    .eq("id", postId);
  if (accountId) {
    const { data: acct } = await supabase
      .from("sp_account")
      .select("consecutive_failures")
      .eq("id", accountId)
      .maybeSingle();
    await supabase
      .from("sp_account")
      .update({ consecutive_failures: ((acct?.consecutive_failures ?? 0) as number) + 1 })
      .eq("id", accountId);
  }
  await supabase.from("sp_publish_attempt").insert({
    post_id: postId,
    attempt_number: 1,
    outcome: "permanent_fail",
    error_message: message,
    auth_mode: "cookie",
  });
}
