import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { createEmailer } from "@profullstack/stack/email";
import { markdownToEmailHtml, markdownToPlainText } from "@/lib/emailMarkdown";
import { sendableEmails } from "@/lib/emailRecipients";
import { broadcastEmailHtml } from "@/lib/email";

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

  // Count what Resend will actually accept, so the number in the form matches the send.
  const emails = sendableEmails((data ?? []).map((r) => r.email));
  return NextResponse.json({
    count: emails.length,
    skipped: (data ?? []).length - emails.length,
  });
}

export async function POST(req: NextRequest) {
  const auth = await checkAdmin();
  if (!auth.ok) return auth.response;

  let body: {
    subject?: string;
    markdown?: string;
    html?: string;
    text?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { subject, markdown } = body;
  if (!subject || !(markdown ?? body.html)) {
    return NextResponse.json(
      { error: "subject and markdown are required" },
      { status: 400 },
    );
  }

  // Markdown is rendered here rather than in the browser: the client sends the source,
  // the server owns the HTML. `html` stays accepted for any older caller.
  const html = markdown
    ? broadcastEmailHtml({ subject, bodyHtml: markdownToEmailHtml(markdown) })
    : (body.html as string);
  const text = markdown ? markdownToPlainText(markdown) : body.text;

  const svc = serviceClient();
  const { data, error } = await svc
    .from("profiles")
    .select("email")
    .not("email", "is", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Reserved-domain addresses (example.com and friends) make Resend 422 the whole
  // batch of 100 they land in, so they are dropped before the send.
  const allEmails = (data ?? []).map((r: { email: string | null }) => r.email);
  const emails = sendableEmails(allEmails);
  const skipped = allEmails.filter(Boolean).length - emails.length;

  if (emails.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, skipped });
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
    `[admin/email-broadcast] sent=${result.sent} failed=${result.failed} skipped=${skipped}`,
  );

  return NextResponse.json({
    sent: result.sent,
    failed: result.failed,
    skipped,
    error: result.errors?.[0]?.error,
  });
}
