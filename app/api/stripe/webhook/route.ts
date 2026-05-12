import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, sig, env.stripeWebhookSecret);
  } catch (err) {
    console.error("[stripe] bad signature", err);
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }

  const svc = serviceClient();

  async function setPlan(customerId: string, plan: "free" | "pro") {
    await svc
      .from("profiles")
      .update({ plan })
      .eq("stripe_customer_id", customerId);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id;
      if (customerId) await setPlan(customerId, "pro");
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const active = ["trialing", "active"].includes(sub.status);
      await setPlan(customerId, active ? "pro" : "free");
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      await setPlan(customerId, "free");
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
