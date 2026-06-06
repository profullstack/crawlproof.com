import { afterEach, describe, expect, it, vi } from "vitest";
import { recipientHash, sendOutreachSms } from "@/lib/outreach";
import { env } from "@/lib/env";
import { encryptSecret } from "@/lib/sp/vault";

describe("outreach utilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hashes recipients case-insensitively and trims whitespace", () => {
    expect(recipientHash("  Lead@Example.com ")).toBe(recipientHash("lead@example.com"));
  });

  it("does not collapse different recipients into the same hash", () => {
    expect(recipientHash("one@example.com")).not.toBe(recipientHash("two@example.com"));
  });

  it("decrypts encrypted Twilio auth tokens from org sender configs", async () => {
    env.socialVaultKey = Buffer.alloc(32, 7).toString("base64");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ sid: "SM123" }), { status: 201 });
      }),
    );

    const result = await sendOutreachSms({
      to: "+15551234567",
      body: "hello",
      config: {
        provider: "twilio",
        account_sid: "AC123",
        enc_auth_token: encryptSecret("secret-token"),
        from_phone: "+15557654321",
      },
    });

    expect(result).toMatchObject({
      sent: true,
      provider: "twilio",
      providerMessageId: "SM123",
    });
    expect(calls[0]?.url).toContain("/Accounts/AC123/Messages.json");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("AC123:secret-token").toString("base64")}`,
    });
  });
});
