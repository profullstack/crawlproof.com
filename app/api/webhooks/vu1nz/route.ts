import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";

export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const url = new URL(req.url);
  const auditId = url.searchParams.get("audit_id");
  const scanId =
    payload && typeof payload === "object" && "scan_id" in payload
      ? String((payload as { scan_id?: unknown }).scan_id ?? "")
      : "";

  try {
    await serviceClient().from("webhook_events").insert({
      provider: "vu1nz",
      direction: "inbound",
      event_name: "scan.completed",
      idempotency_key: scanId || null,
      request_headers: Object.fromEntries(req.headers.entries()),
      request_payload: {
        audit_id: auditId,
        payload,
      },
      status: "accepted",
    });
  } catch (error) {
    console.warn(
      "[vu1nz webhook] could not record event",
      error instanceof Error ? error.message : error,
    );
  }

  return NextResponse.json({ ok: true });
}
