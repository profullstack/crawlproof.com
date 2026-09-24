// /api/ads/v1/video/renders/[id] — one five-second pre-roll render.
//
//   GET  state (queued | rendering | validating | ready | failed), the revision
//        it is rendering, and — once ready — the downloadable master plus the
//        delivery renditions, HLS playlist and poster.
//
// Owner-scoped: the service client bypasses RLS, so the owner id from the
// bearer token is applied to the query itself rather than relied on from the
// policy. A job id is a uuid somebody may still hold after losing access to
// the campaign it belongs to.
//
// This is a status read, deliberately cheap and pollable. Rendering happens on
// the worker; no request ever waits for an encode.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import {
  downloadableAsset,
  getRenderStatus,
  renderStateLabel,
  streamingReady,
} from "@/lib/ads/video/jobs";
import { ASSET_BUCKET } from "@/lib/ads/video/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const sb = serviceClient();

  const status = await getRenderStatus(sb, {
    jobId: id,
    ownerId: auth.userId,
    publicUrlFor: (key) => sb.storage.from(ASSET_BUCKET).getPublicUrl(key).data.publicUrl,
  });

  if (!status) return NextResponse.json({ error: "No such render." }, { status: 404 });

  const master = downloadableAsset(status);

  return NextResponse.json({
    id: status.jobId,
    state: status.state,
    state_label: renderStateLabel(status.state),
    revision: status.revision,
    campaign_id: status.campaignId,
    error_code: status.errorCode,
    // An advertiser may download a draft render before the campaign is ever
    // activated; what they may not do is have it served. Those are different
    // permissions and this flag is only the second one.
    streaming_ready: streamingReady(status),
    download_url: master?.url ?? null,
    download_bytes: master?.byteSize ?? null,
    assets: status.assets.map((a) => ({
      profile: a.profile,
      url: a.url,
      byte_size: a.byteSize,
      width: a.width,
      height: a.height,
      duration_ms: a.durationMs,
    })),
  });
}
