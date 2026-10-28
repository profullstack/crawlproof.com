// GET /api/keys: the caller's key-seal status (session cookie or crp_ token).
// Returns the public seal record (kdf + wrapped blobs) so the browser or CLI can
// derive the data key from the passphrase locally. Nothing here opens without it.
import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { serviceClient } from "@/lib/supabase/service";
import { isSealRecord } from "@/lib/sealed/crypto";
import { localStatus } from "@/lib/sealed/session";
import { operatorStatus } from "@/lib/sealed/operator";
import { legacyMigrationEnabled } from "@/lib/sealed/legacy";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const sb = serviceClient();
  const { data } = await sb.from("user_key_seal").select("seal, created_at").eq("user_id", who.user.id).maybeSingle();
  const seal = isSealRecord((data as { seal?: unknown } | null)?.seal) ? (data as { seal: unknown }).seal : null;
  const status = localStatus(who.user.id);
  const [{ count: waitingPosts }, { count: lockedFeeds }] = await Promise.all([
    sb.from("sp_post").select("id", { count: "exact", head: true }).eq("user_id", who.user.id).eq("status", "queued_browser"),
    sb.from("sp_feed_config").select("id", { count: "exact", head: true }).eq("user_id", who.user.id).like("last_error", "locked:%"),
  ]);
  const { data: prof } = await sb.from("profiles").select("is_admin").eq("id", who.user.id).maybeSingle();
  return NextResponse.json({
    user_id: who.user.id,
    has_seal: !!seal,
    seal,
    unlocked: status.unlocked,
    unlocked_at: status.unlockedAt,
    expires_at: status.expiresAt,
    state: !seal ? "setup_required" : status.unlocked ? "unlocked" : "locked",
    waiting: { queued_posts: waitingPosts ?? 0, locked_feeds: lockedFeeds ?? 0 },
    legacy_migration: legacyMigrationEnabled() ? "on" : "off",
    operator: (prof as { is_admin?: boolean } | null)?.is_admin ? await operatorStatus() : undefined,
  });
}
