"use server";

import { sendHireInquiryEmail } from "@/lib/email";

type Ok = { ok: true };
type Err = { ok: false; error: string };

const MAX = {
  name: 120,
  email: 254,
  phone: 40,
  website: 500,
  revenue: 60,
  location: 120,
  message: 4000,
};

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

export async function submitHireInquiry(input: {
  name: string;
  email: string;
  phone: string;
  website: string;
  monthlyRevenue?: string;
  location?: string;
  message?: string;
  company?: string; // honeypot — real users leave this blank
}): Promise<Ok | Err> {
  // Honeypot: bots fill every visible field; the hidden "company" input is
  // only filled by automated scrapers. Silently succeed.
  if (input.company && input.company.trim().length > 0) {
    return { ok: true };
  }

  const name = clean(input.name, MAX.name);
  const email = clean(input.email, MAX.email);
  const phone = clean(input.phone, MAX.phone);
  const website = clean(input.website, MAX.website);
  const monthlyRevenue = clean(input.monthlyRevenue, MAX.revenue) || undefined;
  const location = clean(input.location, MAX.location) || undefined;
  const message = clean(input.message, MAX.message) || undefined;

  if (!name) return { ok: false, error: "Name is required." };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "A valid email is required." };
  }
  if (!phone) return { ok: false, error: "Phone is required." };
  if (!website) return { ok: false, error: "Website is required." };

  const res = await sendHireInquiryEmail({
    name,
    email,
    phone,
    website,
    monthlyRevenue,
    location,
    message,
  });
  if (!res.sent) {
    return { ok: false, error: res.error ?? "Could not send. Try again." };
  }
  return { ok: true };
}
