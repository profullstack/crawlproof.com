import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/sp/vault";

export type DeliveryResult = {
  sent: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
};

export type OutreachConfig = {
  provider: string;
  from_email?: string | null;
  from_phone?: string | null;
  reply_to?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_secure?: boolean | null;
  smtp_user?: string | null;
  smtp_pass?: string | null;
  api_key?: string | null;
  account_sid?: string | null;
  auth_token?: string | null;
  enc_smtp_user?: string | null;
  enc_smtp_pass?: string | null;
  enc_api_key?: string | null;
  enc_auth_token?: string | null;
};

export function recipientHash(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export async function sendOutreachEmail(input: {
  to: string;
  subject: string;
  body: string;
  // Optional pre-rendered HTML. When omitted, HTML is derived from `body`.
  html?: string;
  // Extra mail headers (e.g. List-Unsubscribe). Passed to both SMTP and
  // Resend so native unsubscribe buttons render.
  headers?: Record<string, string>;
  replyTo?: string | null;
  config?: OutreachConfig | null;
}): Promise<DeliveryResult> {
  let smtpUser: string | null;
  let smtpPass: string | null;
  let resendApiKey: string;
  try {
    smtpUser = secretValue(input.config?.enc_smtp_user, input.config?.smtp_user);
    smtpPass = secretValue(input.config?.enc_smtp_pass, input.config?.smtp_pass);
    resendApiKey =
      input.config?.provider === "resend"
        ? (secretValue(input.config.enc_api_key, input.config.api_key) ?? "")
        : "";
  } catch (error) {
    return {
      sent: false,
      provider: input.config?.provider ?? "email",
      error: error instanceof Error ? error.message : "Could not decrypt sender config.",
    };
  }

  // Honor an explicit per-org provider choice: a "resend" config must never
  // be hijacked by a global SMTP_HOST env. With no config we keep the legacy
  // default of falling back to the global SMTP host.
  const smtpHost =
    input.config?.provider === "resend"
      ? ""
      : input.config?.provider === "smtp"
        ? input.config.smtp_host ?? env.smtpHost
        : env.smtpHost;
  if (smtpHost) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: input.config?.smtp_port ?? env.smtpPort,
        secure: input.config?.smtp_secure ?? env.smtpSecure,
        auth:
          input.config?.smtp_user ||
          input.config?.smtp_pass ||
          input.config?.enc_smtp_user ||
          input.config?.enc_smtp_pass ||
          env.smtpUser ||
          env.smtpPass
            ? {
                user: smtpUser ?? env.smtpUser,
                pass: smtpPass ?? env.smtpPass,
              }
            : undefined,
      });
      const result = await transporter.sendMail({
        from: input.config?.from_email ?? env.smtpFrom,
        to: input.to,
        replyTo: input.config?.reply_to ?? input.replyTo ?? undefined,
        subject: input.subject,
        text: input.body,
        html: input.html ?? paragraphHtml(input.body),
        headers: input.headers,
      });
      return {
        sent: true,
        provider: "smtp",
        providerMessageId: result.messageId,
      };
    } catch (error) {
      return {
        sent: false,
        provider: "smtp",
        error: error instanceof Error ? error.message : "SMTP send failed.",
      };
    }
  }

  resendApiKey ||= env.resendApiKey;
  if (!resendApiKey) {
    return { sent: false, provider: "email", error: "SMTP_HOST or RESEND_API_KEY is required." };
  }

  const resend = new Resend(resendApiKey);
  const result = await resend.emails.send({
    from: input.config?.from_email ?? env.resendFrom,
    to: input.to,
    replyTo: input.config?.reply_to ?? input.replyTo ?? undefined,
    subject: input.subject,
    text: input.body,
    html: input.html ?? paragraphHtml(input.body),
    headers: input.headers,
  });
  if (result.error) {
    return { sent: false, provider: "resend", error: String(result.error) };
  }
  return { sent: true, provider: "resend", providerMessageId: result.data?.id };
}

export async function sendOutreachSms(input: {
  to: string;
  body: string;
  config?: OutreachConfig | null;
}): Promise<DeliveryResult> {
  try {
    if (input.config?.enc_api_key) input.config.api_key = decryptSecret(input.config.enc_api_key);
    if (input.config?.enc_auth_token) {
      input.config.auth_token = decryptSecret(input.config.enc_auth_token);
    }
  } catch (error) {
    return {
      sent: false,
      provider: input.config?.provider ?? "sms",
      error: error instanceof Error ? error.message : "Could not decrypt SMS config.",
    };
  }

  if (input.config?.provider === "twilio") {
    return sendTwilioSms(input, input.config);
  }
  if (input.config?.provider === "telnyx") {
    return sendTelnyxSms(input, input.config);
  }
  if (env.twilioAccountSid && env.twilioAuthToken && env.twilioFrom) {
    return sendTwilioSms(input);
  }
  if (env.telnyxApiKey && env.telnyxFrom) {
    return sendTelnyxSms(input);
  }
  return {
    sent: false,
    provider: "sms",
    error: "TWILIO_* or TELNYX_* SMS env vars are required.",
  };
}

function secretValue(
  encrypted: string | null | undefined,
  plaintext: string | null | undefined,
) {
  if (encrypted) return decryptSecret(encrypted);
  return plaintext ?? null;
}

async function sendTwilioSms(
  input: { to: string; body: string },
  config?: OutreachConfig | null,
): Promise<DeliveryResult> {
  const accountSid = config?.account_sid ?? env.twilioAccountSid;
  const authToken = config?.auth_token ?? env.twilioAuthToken;
  const from = config?.from_phone ?? env.twilioFrom;
  if (!accountSid || !authToken || !from) {
    return { sent: false, provider: "twilio", error: "Twilio config is incomplete." };
  }
  const body = new URLSearchParams({
    To: input.to,
    From: from,
    Body: input.body,
  });
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
  const json = (await response.json().catch(() => null)) as
    | { sid?: string; message?: string }
    | null;
  if (!response.ok) {
    return {
      sent: false,
      provider: "twilio",
      error: json?.message ?? `Twilio returned HTTP ${response.status}.`,
    };
  }
  return { sent: true, provider: "twilio", providerMessageId: json?.sid };
}

async function sendTelnyxSms(
  input: { to: string; body: string },
  config?: OutreachConfig | null,
): Promise<DeliveryResult> {
  const apiKey = config?.api_key ?? env.telnyxApiKey;
  const from = config?.from_phone ?? env.telnyxFrom;
  if (!apiKey || !from) {
    return { sent: false, provider: "telnyx", error: "Telnyx config is incomplete." };
  }
  const response = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: input.to,
      text: input.body,
    }),
  });
  const json = (await response.json().catch(() => null)) as
    | { data?: { id?: string }; errors?: Array<{ detail?: string; title?: string }> }
    | null;
  if (!response.ok) {
    const first = json?.errors?.[0];
    return {
      sent: false,
      provider: "telnyx",
      error: first?.detail ?? first?.title ?? `Telnyx returned HTTP ${response.status}.`,
    };
  }
  return { sent: true, provider: "telnyx", providerMessageId: json?.data?.id };
}

function paragraphHtml(body: string) {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
