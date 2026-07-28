// Is this person asking for what you sell?
//
// Keyword matching answers a narrower question — does this text contain a word
// you listed — and drops the requests most worth having. Somebody writing "our
// pipeline keeps falling over under traffic" is exactly the buyer a load
// testing campaign wants, and contains none of its keywords, because people
// with a problem describe the problem rather than the product category that
// solves it.
//
// So a second path: judge the text against a prose description of what the
// campaign sells. Deliberately the *second* path, and deliberately narrow:
//
//   - It only ever runs on signals the cheap path already found interesting
//     enough to score. Running a model over a raw result set would be
//     unbounded spend for a judgement most results do not need.
//   - It cannot rescue a disqualified signal. Someone who wrote "no vendors"
//     is not a lead however relevant they are, and a relevance judgement is
//     not entitled to overturn a stated no.
//   - It must give a reason. A keyword match is legible and wrong in obvious
//     ways; a model deciding relevance is wrong in ways nobody sees unless it
//     says why, and an unauditable score is one nobody can correct.

import { z } from "zod/v4";
import { env } from "@/lib/env";
import { generateStructuredOutput } from "@/lib/lx/backendAi";
import { aiClients } from "./pipeline";

const RelevanceSchema = z.object({
  relevant: z
    .boolean()
    .describe("True only if this person is asking for something the business sells."),
  confidence: z.number().describe("0-100. How sure you are."),
  reason: z
    .string()
    .describe("One short sentence, quoting the words that decided it."),
});

export type RelevanceVerdict = {
  relevant: boolean;
  confidence: number;
  reason: string;
};

const SYSTEM = `You decide whether a public post is somebody asking for a product or service that a specific business sells.

You are given what the business sells, and one post. Answer one question: is the author of this post looking for something this business could provide?

Say yes when the author describes a need this business addresses, even if they use none of the business's vocabulary. Somebody saying "our checkout keeps timing out on Black Friday" is asking for load testing whether or not they know the phrase.

Say no when:
- The author is describing a problem this business does not solve.
- The author is selling, advertising, or offering their own services.
- The author is discussing the topic without wanting anything — an opinion, a tutorial, a news link, a retrospective.
- You are unsure. A false yes puts a stranger's inbox or a public thread in front of an irrelevant pitch; a false no costs one lead. They are not equally bad.

confidence is how sure you are, not how strong their intent is — something else already scored that.

reason must quote the words that decided it, so a human can tell whether you were right.`;

/**
 * Judge one post against what a campaign sells.
 *
 * Returns null when there is no description to judge against or no provider
 * configured, which callers treat as "the keyword path is the only path" —
 * never as a rejection. A missing model must not silently narrow the funnel.
 */
export async function judgeRelevance(input: {
  text: string;
  sells: string;
}): Promise<RelevanceVerdict | null> {
  const sells = input.sells?.trim();
  const text = input.text?.trim();
  if (!sells || !text) return null;

  const { anthropic, openai } = aiClients();
  if (!anthropic && !openai) return null;

  try {
    const res = await generateStructuredOutput({
      name: "intent_relevance",
      schema: RelevanceSchema,
      system: SYSTEM,
      user: [
        "THE BUSINESS SELLS:",
        sells.slice(0, 2000),
        "",
        "THE POST:",
        text.slice(0, 4000),
      ].join("\n"),
      anthropic,
      openai,
      preference: env.backendAiProvider,
      // The cheapest model that can do this: it is one yes/no per shortlisted
      // signal, and the sweep runs every fifteen minutes.
      anthropicModel: "claude-haiku-4-5-20251001",
      openaiModel: env.backendAiOpenaiModel,
      maxTokens: 300,
      anthropicEffort: false,
    });
    return {
      relevant: Boolean(res.output.relevant),
      confidence: Math.max(0, Math.min(100, Math.round(res.output.confidence))),
      reason: res.output.reason.trim().slice(0, 300),
    };
  } catch {
    // A failed judgement is not a rejection. The keyword path still stands.
    return null;
  }
}

/** Below this the model is guessing, and a guess is not a reason to contact someone. */
export const MIN_RELEVANCE_CONFIDENCE = 65;

export function acceptsRelevance(verdict: RelevanceVerdict | null): boolean {
  if (!verdict) return false;
  return verdict.relevant && verdict.confidence >= MIN_RELEVANCE_CONFIDENCE;
}
