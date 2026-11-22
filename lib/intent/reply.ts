// Draft a reply to a public post. The user copies it and posts it themselves:
// CrawlProof never asks for social logins and never posts for you.

import { z } from "zod/v4";
import { env } from "@/lib/env";
import { generateStructuredOutput } from "@/lib/lx/backendAi";
import { aiClients } from "@/lib/outreach/pipeline";

const ReplySchema = z.object({
  reply: z.string(),
});

const SYSTEM = `You write a short reply to a public community post (Reddit, Hacker News, Stack Overflow, a forum, X, LinkedIn).

The person replying sells something that may help the author. Write the reply that person would post themselves.

Rules:
- Answer the author's actual question first, with something genuinely useful even if they never buy.
- The first two sentences must be concrete help (a step, a check, a tool category, a pitfall) and must not name the product.
- Never write "this is the right fit" or any sales line; one plain disclosure ("I build X, which does Y") at the end is the most allowed.
- Mention the product at most once, plainly, and say you make it ("I build X"), never pretend to be a neutral user.
- If the product is not a good fit for what they asked, do not mention it at all; just help.
- 40 to 120 words. Plain text. No hashtags, no emoji, no bullet lists, no greeting like "Great question".
- Match the register of the platform: terse and technical on Hacker News and Stack Overflow, casual on Reddit.
- Never invent facts about the product beyond what you are told.`;

export async function draftReply(input: {
  title: string;
  snippet: string;
  source: string;
  sells: string | null;
  productName: string;
}): Promise<string> {
  const { anthropic, openai } = aiClients();
  const res = await generateStructuredOutput({
    name: "intent_reply_draft",
    schema: ReplySchema,
    system: SYSTEM,
    user: [
      `PLATFORM: ${input.source}`,
      `THE PRODUCT: ${input.productName}`,
      `WHAT IT DOES: ${(input.sells ?? "").slice(0, 1500) || "(not described: keep the mention generic or leave it out)"}`,
      "",
      "THE POST:",
      `${input.title}\n${input.snippet}`.slice(0, 4000),
    ].join("\n"),
    anthropic,
    openai,
    preference: env.backendAiProvider,
    anthropicModel: "claude-haiku-4-5-20251001",
    openaiModel: env.backendAiOpenaiModel,
    maxTokens: 500,
    anthropicEffort: false,
  });
  return res.output.reply.trim().slice(0, 2000);
}
