// Discord platform module — channel webhooks.
//
// Auth model: a Discord channel webhook URL. The user creates one in
// their channel settings (Edit Channel → Integrations → Webhooks → New
// Webhook → Copy URL) and pastes it into our setup form. No OAuth, no
// app registration, no scopes. The URL itself is the secret.
//
// Webhook URL shape:
//   https://discord.com/api/webhooks/{webhook_id}/{webhook_token}
//
// We validate the URL by GET'ing it — Discord returns the webhook
// object (id, name, channel_id, guild_id). If that succeeds, the
// webhook is real and we know which channel it posts to.
//
// Posting: POST the same URL with JSON {content: "..."}. Discord's
// content limit is 2000 chars.

export const DISCORD_MAX_CHARS = 2000;

const WEBHOOK_URL_REGEX =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

export type DiscordWebhookInfo = {
  id: string; // webhook id (stable per webhook)
  name: string; // webhook display name
  channelId: string;
  guildId: string | null; // null for DM webhooks (rare)
  // Resolved display label combining server + channel where possible.
  // We can only get IDs without a bot token, so display lives at "#<channel-id>".
  displayHandle: string;
};

export function validateDiscordWebhookUrl(url: string): string {
  const u = url.trim();
  if (!WEBHOOK_URL_REGEX.test(u)) {
    throw new Error("Not a Discord webhook URL.");
  }
  return u;
}

// Probe a webhook URL to confirm it's live + extract id / channel.
// Discord requires no auth on this GET — the token is in the path.
export async function getDiscordWebhookInfo(
  webhookUrl: string,
): Promise<DiscordWebhookInfo> {
  const url = validateDiscordWebhookUrl(webhookUrl);
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook check ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    id?: string;
    name?: string;
    channel_id?: string;
    guild_id?: string;
  };
  if (!json.id || !json.channel_id) {
    throw new Error("Discord webhook response missing id / channel_id.");
  }
  return {
    id: json.id,
    name: json.name ?? "Discord webhook",
    channelId: json.channel_id,
    guildId: json.guild_id ?? null,
    displayHandle: `${json.name ?? "webhook"} (#${json.channel_id})`,
  };
}

export type DiscordPostResult = {
  messageId: string;
  webUrl: string;
};

// POST a text message to the webhook. Using `?wait=true` so the response
// includes the created message id — gives us a stable platform_post_id +
// permalink for the sp_post row.
export async function postDiscordWebhook(input: {
  webhookUrl: string;
  text: string;
}): Promise<DiscordPostResult> {
  const url = validateDiscordWebhookUrl(input.webhookUrl);
  const content = input.text.slice(0, DISCORD_MAX_CHARS);
  const res = await fetch(`${url}?wait=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook post ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  if (!json.id || !json.channel_id) {
    throw new Error("Discord webhook response missing id / channel_id.");
  }
  // Discord message URL pattern:
  //   https://discord.com/channels/{guild_id|"@me"}/{channel_id}/{message_id}
  const guildPart = json.guild_id ?? "@me";
  return {
    messageId: json.id,
    webUrl: `https://discord.com/channels/${guildPart}/${json.channel_id}/${json.id}`,
  };
}
