import { beforeAll, describe, expect, it, vi } from "vitest";

// The cross-promo block reads its bundled catalog, never the CDN, in tests.
process.env.CROSS_PROMO = "bundled";
process.env.RESEND_API_KEY ||= "re_test";

const sent: Array<{ to: string; subject: string; html: string }> = [];
vi.mock("@profullstack/stack/email", () => ({
  createEmailer: () => ({
    send: vi.fn(async (m: { to: string; subject: string; html: string }) => {
      sent.push(m);
      return { sent: true };
    }),
  }),
}));

let email: typeof import("@/lib/email");
beforeAll(async () => {
  email = await import("@/lib/email");
});

describe("purchase receipt cross-promo", () => {
  it("promotes publisher sites to a credits buyer, never crawlproof.com itself", async () => {
    const promo = await email.receiptPromo("buyer@example.com");
    expect(promo.items.length).toBeGreaterThan(0);
    expect(promo.items.map((i) => i.id)).toContain("rssamplifier.com");
    expect(promo.items.map((i) => i.id)).not.toContain("crawlproof.com");
    expect(promo.html).not.toContain('href="https://crawlproof.com');
    expect(promo.html).toContain("utm_source=crawlproof.com");
  });

  it("puts the block in the receipt after the billing link", async () => {
    const res = await email.sendPurchaseReceiptEmail({
      to: "buyer@example.com",
      paymentId: "pay_1234567890abcdef",
      packLabel: "Starter",
      creditsAdded: 10,
      amountCents: 1000,
      currency: "USD",
      completedAt: new Date().toISOString(),
      pdf: Buffer.from("%PDF-1.4"),
    });
    expect(res.sent).toBe(true);
    const html = sent.at(-1)!.html;
    expect(html).toContain("Grow your readership");
    expect(html).toContain("https://rssamp.com");
    expect(html).not.toContain('href="https://crawlproof.com/?utm');
    expect(html.indexOf("View billing")).toBeLessThan(html.indexOf("Grow your readership"));
  });

  it("renders the receipt unchanged without a promo", () => {
    const html = email.purchaseReceiptEmailHtml({
      packLabel: "Starter",
      creditsAdded: 1,
      amountFormatted: "$1",
      currency: "USD",
      paymentId: "pay_x",
    });
    expect(html).not.toContain("Grow your readership");
  });
});
