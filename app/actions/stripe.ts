"use server";

import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";

export async function startCheckout(): Promise<
  { ok: true; url: string } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  if (!env.stripeProPriceId) return { ok: false, error: "Stripe price not configured." };

  // Find or create customer.
  const svc = serviceClient();
  const { data: prof } = await svc
    .from("profiles")
    .select("stripe_customer_id, email")
    .eq("id", user.id)
    .maybeSingle();

  let customerId = prof?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe().customers.create({
      email: prof?.email ?? user.email ?? undefined,
      metadata: { profile_id: user.id },
    });
    customerId = customer.id;
    await svc.from("profiles").update({ stripe_customer_id: customerId }).eq("id", user.id);
  }

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: env.stripeProPriceId, quantity: 1 }],
    success_url: `${env.siteUrl}/settings/billing?checkout=success`,
    cancel_url: `${env.siteUrl}/settings/billing?checkout=cancel`,
    allow_promotion_codes: true,
    metadata: { profile_id: user.id },
  });
  if (!session.url) return { ok: false, error: "Stripe did not return a URL." };
  return { ok: true, url: session.url };
}

export async function openPortal(): Promise<
  { ok: true; url: string } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const svc = serviceClient();
  const { data: prof } = await svc
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!prof?.stripe_customer_id) {
    return { ok: false, error: "No Stripe customer found." };
  }
  const portal = await stripe().billingPortal.sessions.create({
    customer: prof.stripe_customer_id,
    return_url: `${env.siteUrl}/settings/billing`,
  });
  return { ok: true, url: portal.url };
}
