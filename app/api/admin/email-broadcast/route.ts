import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { createEmailer } from "@profullstack/emailer";

export const runtime = "nodejs";

async function checkAdmin(): Promise<
  { ok: true } | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const { data: me } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (!me?.is_admin) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { ok: true };
}

export async function GET(_req: NextRequest) {
  const auth = await checkAdmin();
  if (!auth.ok) return auth.response;

  const svc = serviceClient();
  const { data, error } = await svc
    .from("profiles")
    .select("email")
    .not("email", "is", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const count = (data ?? []).length;
  return NextResponse.json({ count });
}

export async function POST(req: NextRequest) {
  const auth = await checkAdmin();
  if (!auth.ok) return auth.response;

  let body: { subject?: string; html?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { subject, html, text } = body;
  if (!subject || !html) {
    return NextResponse.json(
      { error: "subject and html are required" },
      { status: 400 },
    );
  }

  const svc = serviceClient();
  const { data, error } = await svc
    .from("profiles")
    .select("email")
    .not("email", "is", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const emails = (data ?? [])
    .map((r: { email: string | null }) => r.email)
    .filter((e): e is string => Boolean(e));

  if (emails.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0 });
  }

  const emailer = createEmailer({ resendApiKey: env.resendApiKey });
  const result = await emailer.sendBulk({
    from: env.resendFrom,
    to: emails,
    subject,
    html,
    text,
  });

  console.log(
    `[admin/email-broadcast] sent=${result.sent} failed=${result.failed}`,
  );

  return NextResponse.json({ sent: result.sent, failed: result.failed });
}
