// Reddit outreach pipeline — find, draft, send.
//
// Same shape as the email pipeline: the decisions live here, the MCP tool and
// the /leads UI are both thin callers, so the guardrails cannot differ
// between "what the agent does" and "what the button does".
//
// The tool this is modelled on (signal-found/sf-mcp) advertises thousands of
// DMs a day through a browser extension replaying your session or a farm of
// managed accounts. That is against Reddit's User Agreement and ends with the
// accounts suspended and the domain blocked sitewide. What actually works is
// answering the question someone asked, in public, with a disclosure — a
// low-volume activity, which is why the throttles here are part of the
// design rather than a safety bolt-on.

import { env } from "@/lib/env";
import { serviceClient } from "@/lib/supabase/service";
import { generateStructuredOutput } from "@/lib/lx/backendAi";
import { z } from "zod/v4";
import {
  buildSearchQueries,
  explainRedditSuppression,
  redditSuppressionReason,
  rulesForbidPromotion,
  scoreThread,
  validateReply,
  type RedditChannel,
  type RedditThread,
} from "./reddit";
import { isRedditUserSuppressed, sendsInLast24h } from "./suppress";
import { aiClients } from "./pipeline";
import {
  RedditScopeError,
  getThread,
  postRedditComment,
  redditConnection,
  searchThreads,
  sendRedditMessage,
  subredditRules,
} from "@/lib/sp/platforms/redditOutreach";

function siteHost(): string {
  try {
    return new URL(env.siteUrl).hostname.replace(/^www\./, "");
  } catch {
    return "crawlproof.com";
  }
}

function describeError(err: unknown): string {
  if (err instanceof RedditScopeError) return err.message;
  return err instanceof Error ? err.message : "Unknown Reddit error.";
}

export type ScoredThread = {
  id: string;
  subreddit: string;
  title: string;
  author: string;
  permalink: string;
  ageHours: number;
  numComments: number;
  relevance: number;
  reasons: string;
  ruleWarning: string | null;
};

export type FindThreadsResult =
  | { ok: true; username: string; threads: ScoredThread[]; note?: string }
  | { ok: false; error: string };

export async function findRedditThreads(input: {
  userId: string;
  keywords: string[];
  subreddits?: string[];
  negativeKeywords?: string[];
  maxAgeHours?: number;
  minRelevance?: number;
  limit?: number;
}): Promise<FindThreadsResult> {
  let conn;
  try {
    conn = await redditConnection(input.userId);
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }

  const maxAgeHours = input.maxAgeHours ?? 72;
  const queries = buildSearchQueries({
    keywords: input.keywords,
    subreddits: input.subreddits ?? [],
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const byId = new Map<string, RedditThread>();
  const failures: string[] = [];

  for (const q of queries.slice(0, 24)) {
    try {
      const threads = await searchThreads({
        accessToken: conn.accessToken,
        query: q.query,
        subreddit: q.subreddit,
        timeframe: maxAgeHours <= 24 ? "day" : "week",
      });
      for (const t of threads) byId.set(t.id, t);
    } catch (err) {
      if (err instanceof RedditScopeError) return { ok: false, error: err.message };
      failures.push(`${q.subreddit ? `r/${q.subreddit}` : "all"}:"${q.query}" — ${describeError(err)}`);
    }
  }

  const minRelevance = input.minRelevance ?? 45;
  const scored = [...byId.values()]
    .map((thread) => ({
      thread,
      relevance: scoreThread({
        thread,
        keywords: input.keywords,
        negativeKeywords: input.negativeKeywords,
        maxAgeHours,
        nowSeconds,
      }),
    }))
    .filter((r) => !r.relevance.disqualified && r.relevance.score >= minRelevance)
    .sort((a, b) => b.relevance.score - a.relevance.score)
    .slice(0, Math.min(input.limit ?? 10, 25));

  if (!scored.length) {
    return {
      ok: true,
      username: conn.username,
      threads: [],
      note: `Searched ${queries.length} queries, found ${byId.size} threads, none scoring ${minRelevance}+ within ${maxAgeHours}h.${
        failures.length ? `\nQuery failures:\n${failures.slice(0, 5).join("\n")}` : ""
      }`,
    };
  }

  // Rules are fetched only for subreddits that made the cut — one call per
  // subreddit, not per thread.
  const subs = [...new Set(scored.map((s) => s.thread.subreddit))];
  const ruleBlocks = new Map<string, string | null>();
  for (const sub of subs.slice(0, 8)) {
    try {
      ruleBlocks.set(
        sub,
        rulesForbidPromotion(await subredditRules({ accessToken: conn.accessToken, subreddit: sub })),
      );
    } catch {
      ruleBlocks.set(sub, null);
    }
  }

  return {
    ok: true,
    username: conn.username,
    threads: scored.map((s) => {
      const blocked = ruleBlocks.get(s.thread.subreddit);
      return {
        id: s.thread.id,
        subreddit: s.thread.subreddit,
        title: s.thread.title,
        author: s.thread.author,
        permalink: s.thread.permalink,
        ageHours: Math.round((nowSeconds - s.thread.createdUtc) / 3600),
        numComments: s.thread.numComments,
        relevance: s.relevance.score,
        reasons: s.relevance.reasons.join("; "),
        ruleWarning: blocked
          ? `subreddit rule blocks promotion: "${blocked}" — reply without any link, or skip`
          : null,
      };
    }),
  };
}

const ReplySchema = z.object({
  body: z.string().describe("The reply or DM text, in Reddit markdown."),
  answers_question: z
    .string()
    .describe("One line: what specific thing in their post this reply actually answers."),
});

const REPLY_SYSTEM = `You write Reddit replies on behalf of someone who built CrawlProof, a tool that scans websites for how they read to AI answer engines.

You are answering a real person's post. The reply must be worth reading even if they never click anything.

Hard rules:
1. Answer their actual question first, concretely, in your own words. If you cannot answer it usefully without the product, say so plainly and write a short honest reply that does not pitch.
2. Mention the tool at most once, at the end, and only if it is genuinely relevant to what they asked.
3. If you mention it, disclose ownership in plain words: "I built X" or "disclosure: I work on X". Never write as a satisfied third-party user.
4. Never lead with the link.
5. No marketing voice. No "Great question!", no "Hope this helps!", no bullet-point listicle, no bold headers. Write the way a knowledgeable person types a comment.
6. Under 150 words. Reddit punishes essays under someone's question.
7. Never invent numbers, benchmarks, or case studies.
8. No "DM me", no offers, no urgency.`;

export type DraftReplyResult =
  | {
      ok: true;
      body: string;
      answers: string;
      subreddit: string;
      title: string;
      permalink: string;
      username: string;
      redditChannel: RedditChannel;
    }
  | { ok: false; error: string };

export async function draftRedditReply(input: {
  userId: string;
  threadId: string;
  redditChannel: RedditChannel;
  angle?: string | null;
  mentionProduct?: boolean;
}): Promise<DraftReplyResult> {
  let conn;
  try {
    conn = await redditConnection(input.userId);
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }

  let thread: RedditThread | null;
  try {
    thread = await getThread({ accessToken: conn.accessToken, fullname: input.threadId });
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
  if (!thread) return { ok: false, error: `No thread found for ${input.threadId}.` };
  if (thread.author.toLowerCase() === conn.username.toLowerCase()) {
    return { ok: false, error: "That is your own post." };
  }

  const { anthropic, openai } = aiClients();
  if (!anthropic && !openai) {
    return { ok: false, error: "No AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY)." };
  }

  const mention = input.mentionProduct !== false;
  const userPrompt = [
    `Subreddit: r/${thread.subreddit}`,
    `Post title: ${thread.title}`,
    `Post body: ${thread.selftext.slice(0, 2000) || "(no body — title only)"}`,
    `Author: u/${thread.author}`,
    `Comments already: ${thread.numComments}`,
    "",
    mention
      ? `You may mention CrawlProof (${siteHost()}) once, at the end, with an explicit "I built it" disclosure — but only if it genuinely bears on what they asked. If it doesn't, leave it out entirely and just answer.`
      : "Do NOT mention CrawlProof or link to it at all. Just answer the question.",
    input.angle ? `Focus: ${input.angle}` : "",
    input.redditChannel === "dm"
      ? "This is a private message, not a public comment. Name the specific post you are responding to in the first sentence, and keep it shorter than a comment would be."
      : "This is a public comment on their post.",
  ]
    .filter(Boolean)
    .join("\n");

  let draft: { body: string; answers_question: string };
  try {
    const { output } = await generateStructuredOutput({
      name: "reddit_outreach_reply",
      schema: ReplySchema,
      system: REPLY_SYSTEM,
      user: userPrompt,
      anthropic,
      openai,
      preference: env.backendAiProvider,
      anthropicModel: "claude-haiku-4-5-20251001",
      openaiModel: env.backendAiOpenaiModel,
      maxTokens: 800,
      anthropicEffort: false,
    });
    draft = output;
  } catch (err) {
    return { ok: false, error: `Draft generation failed: ${describeError(err)}` };
  }

  const check = validateReply({
    body: draft.body,
    siteHost: siteHost(),
    channel: input.redditChannel,
    thread,
  });
  if (!check.ok) {
    return {
      ok: false,
      error: `Draft rejected:\n${check.problems.map((p) => `  • ${p}`).join("\n")}\n\nRe-run, or set mention_product false to answer without pitching.`,
    };
  }

  return {
    ok: true,
    body: draft.body.trim(),
    answers: draft.answers_question,
    subreddit: thread.subreddit,
    title: thread.title,
    permalink: thread.permalink,
    username: conn.username,
    redditChannel: input.redditChannel,
  };
}

export type SendRedditResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * The only function that posts to Reddit. Every check lives inside it so a
 * new caller cannot forget one.
 */
export async function sendRedditOutreach(input: {
  userId: string;
  projectId: string;
  threadId: string;
  body: string;
  subject?: string;
  redditChannel: RedditChannel;
  campaign: string;
  dryRun: boolean;
}): Promise<SendRedditResult> {
  const sb = serviceClient();

  let conn;
  try {
    conn = await redditConnection(input.userId);
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }

  let thread: RedditThread | null;
  try {
    thread = await getThread({ accessToken: conn.accessToken, fullname: input.threadId });
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
  if (!thread) return { ok: false, error: `No thread found for ${input.threadId}.` };
  if (thread.author.toLowerCase() === conn.username.toLowerCase()) {
    return { ok: false, error: explainRedditSuppression("self") };
  }

  // The subreddit's own rules outrank anything we think about the thread.
  // Fetched live rather than cached: rules change, and a stale "promotion
  // allowed" is how a domain gets banned sitewide.
  let forbids: string | null = null;
  try {
    forbids = rulesForbidPromotion(
      await subredditRules({ accessToken: conn.accessToken, subreddit: thread.subreddit }),
    );
  } catch {
    // Unreadable rules are not permission. Continue; the static no-promo list
    // and the reply checks still apply.
  }
  const linksToUs = input.body.toLowerCase().includes(siteHost());
  // A no-promotion rule blocks a promotional reply, not a helpful one —
  // answering without a link is always allowed.
  const ruleBlock = forbids && linksToUs ? forbids : null;

  const [suppressed, priorDm, priorThread, sentToday, sentInSub] = await Promise.all([
    isRedditUserSuppressed(thread.author),
    sb
      .from("outreach_sends")
      .select("id")
      .eq("owner_id", input.userId)
      .eq("channel", "reddit_dm")
      .eq("dry_run", false)
      .ilike("recipient", thread.author)
      .limit(1),
    sb
      .from("outreach_sends")
      .select("id")
      .eq("owner_id", input.userId)
      .eq("channel", "reddit_comment")
      .eq("dry_run", false)
      .eq("target_url", thread.permalink)
      .limit(1),
    sendsInLast24h({ ownerId: input.userId, channels: ["reddit_comment", "reddit_dm"] }),
    sendsInLast24h({
      ownerId: input.userId,
      channels: ["reddit_comment", "reddit_dm"],
      subreddit: thread.subreddit,
    }),
  ]);

  const reason = redditSuppressionReason({
    username: thread.author,
    suppressed,
    contactedBefore: ((priorDm.data as unknown[] | null) ?? []).length > 0,
    repliedInThread: ((priorThread.data as unknown[] | null) ?? []).length > 0,
    sentToday,
    dailyCap: env.redditOutreachDailyCap,
    sentInSubredditToday: sentInSub,
    subredditCap: env.redditOutreachSubredditCap,
    subredditForbidsPromotion: ruleBlock,
    channel: input.redditChannel,
  });
  if (reason) {
    return {
      ok: false,
      error: `Not posting — ${explainRedditSuppression(reason)}.${
        reason === "subreddit-forbids-promotion"
          ? ` (r/${thread.subreddit}: "${ruleBlock}". Remove the link and answer plainly, and this passes.)`
          : ""
      }`,
    };
  }

  const check = validateReply({
    body: input.body,
    siteHost: siteHost(),
    channel: input.redditChannel,
    thread,
  });
  if (!check.ok) {
    return { ok: false, error: `Refusing to post:\n${check.problems.map((p) => `  • ${p}`).join("\n")}` };
  }

  let permalink: string | null = null;
  let sendError: string | undefined;
  if (!input.dryRun) {
    try {
      if (input.redditChannel === "comment") {
        const res = await postRedditComment({
          accessToken: conn.accessToken,
          thingId: thread.id,
          text: input.body,
        });
        permalink = res.permalink;
      } else {
        await sendRedditMessage({
          accessToken: conn.accessToken,
          to: thread.author,
          subject: input.subject?.trim() || `About your post in r/${thread.subreddit}`,
          text: input.body,
        });
      }
    } catch (err) {
      sendError = describeError(err);
    }
  }

  const dbChannel = input.redditChannel === "dm" ? "reddit_dm" : "reddit_comment";
  // Upsert a prospect row so the person shows up in the pipeline and carries
  // an unsubscribe token if they later ask to be left alone.
  const { data: prospect } = await sb
    .from("outreach_prospects")
    .upsert(
      {
        project_id: input.projectId,
        owner_id: input.userId,
        channel: "reddit",
        target_key: thread.author.toLowerCase(),
        reddit_username: thread.author,
        thread_id: thread.id,
        subreddit: thread.subreddit,
        site_url: thread.permalink,
        status: input.dryRun || sendError ? "drafted" : "contacted",
        ...(input.dryRun || sendError
          ? {}
          : { last_sent_at: new Date().toISOString(), last_step: 1 }),
      },
      { onConflict: "project_id,channel,target_key" },
    )
    .select("id")
    .maybeSingle();

  await sb.from("outreach_sends").insert({
    project_id: input.projectId,
    owner_id: input.userId,
    prospect_id: (prospect as { id: string } | null)?.id ?? null,
    channel: dbChannel,
    campaign: input.campaign,
    step: 1,
    recipient: thread.author,
    subject: input.redditChannel === "dm" ? input.subject ?? null : null,
    body: input.body,
    target_url: thread.permalink,
    provider: input.dryRun ? "dry-run" : "reddit",
    dry_run: input.dryRun || !!sendError,
  });

  if (sendError) return { ok: false, error: `Reddit refused it: ${sendError}` };

  return {
    ok: true,
    message: input.dryRun
      ? [
          "DRY RUN — nothing was posted.",
          `Target: ${thread.permalink}`,
          `As: u/${conn.username} → u/${thread.author} (${input.redditChannel})`,
          forbids
            ? `Subreddit rule noted: "${forbids}"${linksToUs ? "" : " — your reply has no link, so it passes"}`
            : "No promotion rule found in the subreddit's rules.",
          `Caps: ${sentToday}/${env.redditOutreachDailyCap} today, ${sentInSub}/${env.redditOutreachSubredditCap} in r/${thread.subreddit}`,
          "",
          "Pass dry_run: false to post it.",
        ].join("\n")
      : [
          input.redditChannel === "comment"
            ? `Posted to r/${thread.subreddit}${permalink ? ` → ${permalink}` : ""}`
            : `DM sent to u/${thread.author}.`,
          `Caps now: ${sentToday + 1}/${env.redditOutreachDailyCap} today, ${sentInSub + 1}/${env.redditOutreachSubredditCap} in r/${thread.subreddit}.`,
        ].join("\n"),
  };
}
