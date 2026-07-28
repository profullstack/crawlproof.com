// Turn a rough description of what someone is trying to do into a pitch the
// drafting prompt and the grounding guard can both work with.
//
// The campaign form asks for three precisely-scoped fields — who is writing,
// the single ask, and the checkable claims — and then refuses drafts that
// stray outside them. Someone with a goal in their head does not naturally
// write in that shape: they type the whole thing into every box, which is
// how a live campaign ended up with an ask that was really an intro and a
// facts list that omitted the URL the ask depended on.
//
// So this does the splitting. It is restructuring, not authoring: nothing may
// be added that the person did not say or that their own site does not say
// about itself. A fact invented here is a fact the guard will happily wave
// through into a stranger's inbox, because the guard checks drafts against
// this output — it cannot check this output against reality.

import { z } from "zod/v4";
import { env } from "@/lib/env";
import { aiClients } from "./pipeline";
import { generateStructuredOutput } from "@/lib/lx/backendAi";
import { loadRecipientContext } from "./recipientContext";

const PitchSchema = z.object({
  intro: z
    .string()
    .describe("Who is writing and why, in the first person. One or two sentences."),
  ask: z.string().describe("The single, small thing the recipient is being asked to do."),
  facts: z
    .array(z.string())
    .describe("Checkable claims the email is allowed to state. One claim per entry."),
});

export type GeneratedPitch = z.infer<typeof PitchSchema>;

const SYSTEM = `You turn a rough description of an outreach goal into three fields for a cold-email campaign.

You are restructuring what you are given, not writing new material. This is the whole job.

intro — who is writing and why they are writing, in the first person. One or two sentences.

ask — the single small thing the recipient is asked to do. If the description names a URL, the ask must contain that URL exactly as written, because the email is expected to include it.

facts — the checkable claims the email may state, one per entry. Copy them from the description. Include every URL, number, duration and product name the description mentions, each as its own entry, because a later check refuses any draft that states something absent from this list.

Hard rules:
1. Invent nothing. No numbers, dates, durations, links, company names, credentials or benefits that are not in the material you were given. An invented fact here will be repeated to strangers as true.
2. Do not embellish a claim into a stronger one. "30 years as a software engineer" does not become "three decades of industry leadership".
3. If the description is vague about what is offered, leave facts short. A short honest list is worth more than a long invented one.
4. Do not write the email. These are inputs to it.
5. Plain language. No marketing register.`;

/**
 * Build a pitch from a free-text goal.
 *
 * The sender's own site is read when its domain appears in the goal, because
 * a company's own description of itself is the one extra fact available
 * without guessing — and it is exactly the material someone leaves out when
 * describing their goal in a hurry.
 */
export async function generatePitch(input: {
  goal: string;
  senderName?: string | null;
}): Promise<{ ok: true; pitch: GeneratedPitch } | { ok: false; error: string }> {
  const goal = input.goal.trim();
  if (goal.length < 15) {
    return { ok: false, error: "Say a little more about what you're trying to do." };
  }

  const { anthropic, openai } = aiClients();
  if (!anthropic && !openai) {
    return { ok: false, error: "No AI provider is configured." };
  }

  // A domain in the goal is nearly always the sender's own.
  const domain = goal.match(/\b([a-z0-9-]+\.[a-z]{2,})\b/i)?.[1] ?? null;
  const senderContext = domain ? await loadRecipientContext(domain) : null;

  const user = [
    "GOAL, in their own words:",
    goal,
    "",
    senderContext
      ? `Their own site (${domain}) describes itself as: "${senderContext.selfDescription}". You may use this as a fact. Nothing else about them is known.`
      : "Nothing further is known about them beyond the goal above.",
    input.senderName ? `They sign off as: ${input.senderName}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await generateStructuredOutput({
      name: "campaign_pitch",
      schema: PitchSchema,
      system: SYSTEM,
      user,
      anthropic,
      openai,
      preference: env.backendAiProvider,
      anthropicModel: "claude-haiku-4-5-20251001",
      openaiModel: env.backendAiOpenaiModel,
      maxTokens: 900,
      anthropicEffort: false,
    });

    const pitch = res.output;
    const facts = pitch.facts.map((f) => f.trim()).filter(Boolean);

    // Any URL the person wrote has to survive into the facts, or the guard
    // will reject every draft that uses it — which is the exact failure this
    // generator exists to prevent, and the model drops them often enough
    // that it is not worth trusting.
    for (const url of goal.match(/https?:\/\/[^\s<>"')]+/g) ?? []) {
      if (!facts.some((f) => f.includes(url))) facts.push(url);
    }

    if (!facts.length) {
      return {
        ok: false,
        error:
          "Couldn't find anything checkable to say. Add a concrete detail — what you offer, a link, or your background.",
      };
    }

    return { ok: true, pitch: { intro: pitch.intro.trim(), ask: pitch.ask.trim(), facts } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 200) : "Generation failed.",
    };
  }
}
