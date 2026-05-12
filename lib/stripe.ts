import Stripe from "stripe";
import { env } from "./env";

let cached: Stripe | null = null;
export function stripe(): Stripe {
  if (cached) return cached;
  if (!env.stripeSecret) throw new Error("STRIPE_SECRET_KEY is not set");
  cached = new Stripe(env.stripeSecret);
  return cached;
}
