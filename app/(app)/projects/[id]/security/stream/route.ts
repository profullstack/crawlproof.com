// SSE stream for live port-scan feedback (uptime-monitoring-prd.md §12.4).
// The browser opens an EventSource here after requesting a scan; we push each
// status change (queued → running → done/failed) and, on completion, the open
// findings — then close. Server-side we poll the DB (which the worker drives
// from the BullMQ result), so the web tier needs no Redis connection.
import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const POLL_MS = 2000;
// A full 65535-port scan can run many minutes; keep the stream open long
// enough to see it finish.
const MAX_MS = 45 * 60 * 1000;
// Emit an SSE comment periodically so idle proxies don't drop the connection
// while a long scan sits in `running` with no status change.
const HEARTBEAT_MS = 15_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scanId = req.nextUrl.searchParams.get("scanId");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close);

      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const deadline = Date.now() + MAX_MS;
      let lastStatus = "";
      let lastBeat = Date.now();
      try {
        while (!closed && Date.now() < deadline) {
          if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            if (!closed) controller.enqueue(encoder.encode(`: keep-alive\n\n`));
            lastBeat = Date.now();
          }
          const base = supabase
            .from("port_scans")
            .select("id, status, open_ports, completed_at")
            .eq("project_id", id);
          const { data: scan } = scanId
            ? await base.eq("id", scanId).maybeSingle()
            : await base.order("created_at", { ascending: false }).limit(1).maybeSingle();

          if (scan) {
            if (scan.status !== lastStatus) {
              lastStatus = scan.status;
              send("status", scan);
            }
            if (scan.status === "done" || scan.status === "failed") {
              const { data: findings } = await supabase
                .from("port_findings")
                .select("id, port, service, severity, state")
                .eq("project_id", id)
                .eq("state", "open")
                .order("severity", { ascending: false });
              send("done", { scan, findings: findings ?? [] });
              break;
            }
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
