import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { env } from "@/lib/env";

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
};

export function recipientHash(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export async function sendOutreachEmail(input: {
  to: string;
  subject: string;
  body: string;
  replyTo?: string | null;
  config?: OutreachConfig | null;
}): Promise<DeliveryResult> {
  const smtpHost =
    input.config?.provider === "smtp" && input.config.smtp_host
      ? input.config.smtp_host
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
          env.smtpUser ||
          env.smtpPass
            ? {
                user: input.config?.smtp_user ?? env.smtpUser,
                pass: input.config?.smtp_pass ?? env.smtpPass,
              }
            : undefined,
      });
      const result = await transporter.sendMail({
        from: input.config?.from_email ?? env.smtpFrom,
        to: input.to,
        replyTo: input.config?.reply_to ?? input.replyTo ?? undefined,
        subject: input.subject,
        text: input.body,
        html: paragraphHtml(input.body),
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

  if (!env.resendApiKey) {
    return { sent: false, provider: "email", error: "SMTP_HOST or RESEND_API_KEY is required." };
  }

  const resend = new Resend(env.resendApiKey);
  const result = await resend.emails.send({
    from: env.resendFrom,
    to: input.to,
    replyTo: input.replyTo ?? undefined,
    subject: input.subject,
    text: input.body,
    html: paragraphHtml(input.body),
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
