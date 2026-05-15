// POST /api/sp/v1/posts — publish a post via one of the user's
// connected accounts. Same dispatcher (lib/sp/post.ts) that the
// /social dashboard server action uses; the only differences are
// authentication (bearer token vs Supabase session) and source label
// ("api" vs "manual").
//
// Request body:
//   {
//     "account_id": "uuid",
//     "text":       "post body",
//     "subreddit":  "optional, required for reddit",
//     "title":      "optional, required for reddit"
//   }
//
// Response (200):
//   { "post_id": "uuid", "platform_post_id": "...", "web_url": "https://..." }

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { postViaAccount } from "@/lib/sp/post";

type Body = {
  account_id?: string;
  text?: string;
  subreddit?: string;
  title?: string;
};

export async function POST(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON." },
      { status: 400 },
    );
  }

  if (!body.account_id) {
    return NextResponse.json(
      { error: "Missing account_id." },
      { status: 400 },
    );
  }
  if (!body.text || !body.text.trim()) {
    return NextResponse.json({ error: "Missing text." }, { status: 400 });
  }

  const service = serviceClient();
  const result = await postViaAccount({
    supabase: service,
    userId: auth.userId,
    input: {
      accountId: body.account_id,
      text: body.text,
      subreddit: body.subreddit,
      title: body.title,
    },
    source: "api",
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    post_id: result.postId,
    platform_post_id: result.platformPostId,
    web_url: result.webUrl,
  });
}
