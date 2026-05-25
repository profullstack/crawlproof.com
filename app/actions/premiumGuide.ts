"use server";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { sendPremiumDeckEmail } from "@/lib/email";
import { recordLead, recordMarketingConsent } from "@/lib/marketing";
import { serviceClient } from "@/lib/supabase/service";

type Ok = { ok: true; downloadUrl: string };
type Err = { ok: false; error: string };

const PDF_PATH = "/pdfs/CrawlProof_Premium_Deck.pdf";
const MAX = {
  name: 120,
  email: 254,
  company: 160,
  role: 80,
  teamSize: 40,
};

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

export async function requestPremiumGuide(input: {
  name: string;
  email: string;
  company?: string;
  role?: string;
  teamSize?: string;
  marketingOptIn?: boolean;
  website?: string; // honeypot
}): Promise<Ok | Err> {
  if (input.website && input.website.trim().length > 0) {
    return { ok: true, downloadUrl: PDF_PATH };
  }

  const name = clean(input.name, MAX.name);
  const email = clean(input.email, MAX.email).toLowerCase();
  const company = clean(input.company, MAX.company) || undefined;
  const role = clean(input.role, MAX.role) || undefined;
  const teamSize = clean(input.teamSize, MAX.teamSize) || undefined;
  const marketingOptIn = Boolean(input.marketingOptIn);

  if (!name) return { ok: false, error: "Name is required." };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid work email." };
  }

  const svc = serviceClient();
  const { error: leadError } = await svc.from("premium_guide_leads").insert({
    email,
    name,
    company: company ?? null,
    role: role ?? null,
    team_size: teamSize ?? null,
    marketing_opt_in: marketingOptIn,
    source: "get_guide",
  });
  if (leadError) {
    console.warn("[premiumGuide] lead insert failed", leadError.message);
    return { ok: false, error: "Could not save your request. Try again." };
  }

  try {
    if (marketingOptIn) {
      await recordMarketingConsent({ email, source: "get_guide" });
    } else {
      await recordLead({ email, source: "get_guide" });
    }
  } catch (err) {
    console.warn("[premiumGuide] marketing contact failed", err);
  }

  const pdf = await readFile(
    path.join(process.cwd(), "public/pdfs/CrawlProof_Premium_Deck.pdf"),
  );
  const res = await sendPremiumDeckEmail({ to: email, pdf });
  if (!res.sent) {
    return { ok: false, error: res.error ?? "Could not email the guide. Try again." };
  }

  return { ok: true, downloadUrl: PDF_PATH };
}
