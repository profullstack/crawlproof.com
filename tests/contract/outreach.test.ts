import { afterEach, describe, expect, it, vi } from "vitest";
import { recipientHash, sendOutreachSms } from "@/lib/outreach";
import { encryptSecret } from "@/lib/sp/vault";
import { createSeal, openPrivateKey } from "@/lib/sealed/crypto";
import { setSealLoaderForTests } from "@/lib/sealed/vault";
import { clearAllUnlocks, unlockOwner } from "@/lib/sealed/unlockStore";

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
    const owner = "00000000-0000-4000-8000-000000000001";
    const created = await createSeal("correct horse battery", owner, 600_000);
    setSealLoaderForTests(async (id) => (id === owner ? created.seal : null));
    clearAllUnlocks();
    unlockOwner(owner, await openPrivateKey(created.dek, created.seal, owner), 3600);
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
        owner_id: owner,
        account_sid: "AC123",
        enc_auth_token: await encryptSecret("secret-token", { ownerId: owner, field: "enc_auth_token" }),
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
