import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

// The router is a lazy singleton that captures fetch when first built, so the
// stub goes in before the module is imported.
const calls: string[] = [];
vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
  calls.push(String(url));
  if (String(url).endsWith("/api/chat")) {
    const body = JSON.parse(String(init?.body));
    expect(body.p2p_only).toBe(true);
    return Response.json({ jobId: "j1", source: "p2p", model: body.modelName });
  }
  const sse =
    'event: meta\ndata: {"model":"qwen-test"}\n\n' +
    'event: token\ndata: {"text":"```json\\n{\\"headline\\":\\"Hi\\"}\\n```"}\n\n' +
    "event: done\ndata: {}\n\n";
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
});

const { generateStructuredOutput, hasBackendAiTextProvider } = await import("@/lib/lx/backendAi");

describe("backend AI routes through c0mpute first", () => {
  it("counts c0mpute as a provider with no paid key", () => {
    expect(hasBackendAiTextProvider({})).toBe(true);
  });

  it("answers from c0mpute and never touches the paid clients", async () => {
    const paid = {
      responses: { create: vi.fn() },
      messages: { stream: vi.fn() },
    };
    const res = await generateStructuredOutput({
      name: "ad",
      schema: z.object({ headline: z.string() }),
      system: "s",
      user: "u",
      maxTokens: 100,
      anthropicModel: "claude-opus-5",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: paid as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropic: paid as any,
    });
    expect(res).toEqual({ provider: "c0mpute", output: { headline: "Hi" } });
    expect(paid.responses.create).not.toHaveBeenCalled();
    expect(paid.messages.stream).not.toHaveBeenCalled();
    expect(calls.some((u) => u.includes("/api/chat/stream/j1"))).toBe(true);
  });
});
