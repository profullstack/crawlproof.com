// Opens the CoinPay hosted checkout session for a credit_purchases row.
//
// Every buyer surface goes through here: scan credit packs (billing page modal
// and the server action) and partner ad-budget deposits. The cs_ session id is
// written to credit_purchases.coinpay_payment_id, which is what the webhook,
// the status poll, the completion RPC and the receipt all key on.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createCheckoutSession, type CreateSessionResult } from "@/lib/coinpay";
import { env } from "@/lib/env";

export type PurchaseCheckoutInput = {
  sb: SupabaseClient;
  purchaseId: string;
  userId: string;
  email: string | null | undefined;
  packId: string;
  credits: number;
  amountCents: number;
  description: string;
  kind: "credits" | "ad_budget";
  reference?: string;
  /**
   * A partner checking out for one of its own users (ad.network): the buyer's
   * email and the partner's id for them, the partner's hostname as property,
   * and where CoinPay sends the buyer back. Omitted, the session is for the
   * crawlproof account itself and returns to the billing page.
   */
  partner?: {
    customerEmail?: string;
    accountId?: string;
    property?: string;
    successUrl?: string;
    cancelUrl?: string;
  };
};

export function siteBase(): string {
  return (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");
}

export function purchaseMetadata(input: Omit<PurchaseCheckoutInput, "sb" | "description">): Record<string, string> {
  const meta: Record<string, string> = {
    purchase_id: input.purchaseId,
    user_id: input.userId,
    owner_id: input.userId,
    pack_id: input.packId,
    credits: String(input.credits),
    kind: input.kind,
  };
  const email = String(input.partner?.customerEmail || input.email || "").trim();
  if (email) meta.customer_email = email;
  if (input.reference) meta.reference = input.reference.slice(0, 120);
  if (input.partner?.accountId) meta.partner_account_id = input.partner.accountId.slice(0, 200);
  if (input.partner?.property) meta.partner_property = input.partner.property;
  return meta;
}

export async function openPurchaseCheckout(input: PurchaseCheckoutInput): Promise<CreateSessionResult> {
  const partner = input.partner ?? {};
  const email = String(partner.customerEmail || input.email || "").trim();
  if (!email) throw new Error("Your account has no email address, which CoinPay needs for the receipt.");
  const site = siteBase();
  const session = await createCheckoutSession({
    amountCents: input.amountCents,
    description: input.description,
    customerEmail: email,
    accountId: partner.accountId || input.userId,
    metadata: purchaseMetadata(input),
    successUrl: partner.successUrl || `${site}/dashboard/settings/billing?purchase=success&session={CHECKOUT_SESSION_ID}`,
    cancelUrl: partner.cancelUrl || `${site}/dashboard/settings/billing?purchase=cancel`,
    ...(partner.property ? { property: partner.property } : {}),
  });
  const { error } = await input.sb
    .from("credit_purchases")
    .update({ coinpay_payment_id: session.sessionId })
    .eq("id", input.purchaseId);
  if (error) throw new Error(`Could not record the checkout: ${error.message}`);
  return session;
}

export function creditsDescription(credits: number): string {
  return `${credits} CrawlProof scan credit${credits === 1 ? "" : "s"}`;
}

export function adBudgetDescription(amountCents: number): string {
  return `CrawlProof ad budget $${(amountCents / 100).toFixed(2)}`;
}
