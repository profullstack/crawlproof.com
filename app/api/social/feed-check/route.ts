import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { processProjectSocialFeed } from "@/lib/sp/feedAutopost";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const anthropicSdk = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const openaiSdk = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const projectId = (searchParams.get("projectId") ?? "").trim();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!projectId) {
    return new Response("Missing projectId", { status: 400 });
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) {
    return new Response("Project not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();

  const send = (event: string, data: unknown) => {
    try {
      writer.write(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    } catch {
      // client disconnected; ignore
    }
  };

  (async () => {
    try {
      const result = await processProjectSocialFeed(serviceClient(), projectId, {
        clients: { anthropic: anthropicSdk, openai: openaiSdk },
        onProgress: (msg) => send("status", { message: msg }),
      });
      send("done", result);
    } catch (err) {
      send("error", {
        message: err instanceof Error ? err.message : "Feed check failed.",
      });
    } finally {
      try {
        await writer.close();
      } catch {
        // already closed
      }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
