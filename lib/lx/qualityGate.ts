// Pre-publish quality gate for autoblog drafts.
//
// Until now generateArticle() validated exactly one thing — that the internal
// links the model *claimed* to place were physically present — and then wrote
// the row at status='ready'. Everything else about the draft went out unread.
//
// Meanwhile this repo already ships a slop detector that we point at other
// people's sites (lib/audit/checks/slop.ts) and the autoblog SDK ships the
// heuristic gate a receiver applies to posts we deliver
// (@profullstack/autoblog/quality). This module runs both against our own
// output before we spend image money or write the row, so:
//
//   1. We fail on our own terms instead of getting 4xx'd by a receiver.
//   2. A draft that would embarrass us in a Slop Score audit never ships.
//   3. The violations come back as text the model can act on, which lets
//      generateArticle() repair a draft rather than burn the keyword.
//
// Deliberately no LLM call here. The SDK's scoreQuality() would add one, but
// every signal below is deterministic, which keeps the gate free, instant,
// and identical between the test suite and production.

import { scoreHeuristics } from "@profullstack/autoblog/quality";
import type { Post } from "@profullstack/autoblog";
import {
  analyzePage,
  jaccard,
  shingles,
  slopGrade,
  slopScore,
  toSlopPage,
  type SlopGrade,
  type SlopIssue,
} from "../audit/checks/slop";

/**
 * Issue keys from analyzePage() that are meaningful for a rendered article
 * body. The rest of that function inspects full-page concerns — viewport meta,
 * deprecated tags, dev-host leakage, inline-style density — which belong to the
 * receiver's template, not to our markdown. Scoring them here would blame the
 * draft for its host's markup.
 */
const BODY_RELEVANT_ISSUE_KEYS = new Set([
  "content.placeholder",
  "content.filler",
  "content.no_first_party_evidence",
  "content.thin",
  "content.stale_copyright",
  "content.misspelling",
  "code.dead_links",
  "design.placeholder_alt",
]);

/**
 * Near-duplicate threshold against our own prior articles.
 *
 * The site audit flags pages at ≥0.70 because it is judging a stranger's site
 * and wants to be sure before making the accusation. Here we are judging our
 * own generator, where 0.55 shingle overlap between two posts on the same blog
 * already means the second one is mostly a re-run of the first — and it is
 * cheaper to regenerate now than to publish a page that competes with one we
 * published last week.
 */
const NEAR_DUPLICATE_THRESHOLD = 0.55;

/** How much of the body counts as "the intro" for repeated-opening detection. */
const INTRO_CHARS = 200;

/** Prior articles compared against. Beyond this the shingling cost stops paying. */
export const MAX_PRIOR_BODIES = 40;

/**
 * Slop score above which a draft is rejected. 25 is the top of the audit's
 * "Clean" band — we hold our own output to the grade we would want a customer
 * to see on their report.
 */
export const DEFAULT_MAX_SLOP_SCORE = 25;

export type PriorBody = {
  slug: string;
  /** Rendered HTML or markdown — only the word sequence matters. */
  body: string;
};

export type QualityGateInput = {
  html: string;
  title: string;
  metaDescription: string;
  /** Previously generated articles on the same site. */
  priorBodies?: PriorBody[];
  /** Overrides DEFAULT_MAX_SLOP_SCORE. */
  maxSlopScore?: number;
};

export type QualityGateResult = {
  ok: boolean;
  score: number;
  grade: SlopGrade;
  issues: SlopIssue[];
  /**
   * Repair instructions, one per violation, phrased as something the model can
   * act on. Empty iff ok.
   */
  violations: string[];
  metrics: {
    wordCount: number;
    linkCount: number;
    linkDensity: number;
    imageCount: number;
  };
};

/** Strip markdown/HTML down to the word sequence the shingler wants. */
function bodyText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function introKey(text: string): string {
  return text.slice(0, INTRO_CHARS).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

/**
 * Wrap a draft in the minimal Post the SDK's heuristic gate needs. The fields
 * it does not read are filled with placeholders rather than left undefined so
 * a future SDK version that starts reading them fails loudly in tests instead
 * of silently scoring undefined.
 */
function draftPost(input: QualityGateInput): Post {
  return {
    id: "draft",
    url: "https://example.invalid/draft",
    title: input.title,
    slug: "draft",
    excerpt: input.metaDescription,
    html: input.html,
    status: "draft",
    published_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    tags: [],
    categories: [],
  };
}

export function runQualityGate(input: QualityGateInput): QualityGateResult {
  const maxScore = input.maxSlopScore ?? DEFAULT_MAX_SLOP_SCORE;
  const violations: string[] = [];

  // --- 1. Slop signals on the body itself ---------------------------------
  const page = toSlopPage({ url: "https://example.invalid/draft", status: 200, html: input.html });
  // toSlopPage reads <title>/<meta> out of the HTML, which a body fragment has
  // no reason to carry. Supply them so the checks that compare title against
  // body see the real values.
  const analyzed = analyzePage({ ...page, title: input.title, description: input.metaDescription });
  const bodyIssues = analyzed.issues.filter((i) => BODY_RELEVANT_ISSUE_KEYS.has(i.key));

  for (const issue of bodyIssues) {
    violations.push(`${issue.label}. ${issue.fix}`);
  }

  // --- 2. The heuristic gate our own receivers will apply ------------------
  // Failing here means the post would be rejected on delivery, so catching it
  // now converts a wasted webhook round-trip into a repair.
  //
  // Note on link density: the SDK already skips in-page anchors (href="#…"),
  // so our 40-link table of contents does not count against us, and its
  // `linkDensity` metric is already expressed in percent.
  const heuristics = scoreHeuristics(draftPost(input));
  for (const failure of heuristics.failed) {
    violations.push(
      `Receiver heuristic gate would reject this post: ${failure} (words=${heuristics.metrics.wordCount}, links=${heuristics.metrics.linkCount}, link density=${heuristics.metrics.linkDensity.toFixed(2)}%, images=${heuristics.metrics.imageCount}).`,
    );
  }

  // --- 3. Cross-article duplication ---------------------------------------
  // The single most damning signal an audit can find on a scaled blog, and the
  // one a single-page check structurally cannot see.
  const siteIssues: SlopIssue[] = [];
  const priors = (input.priorBodies ?? []).slice(0, MAX_PRIOR_BODIES);
  if (priors.length > 0) {
    const draftText = bodyText(input.html);
    const draftShingles = shingles(draftText);

    const dupes: Array<{ slug: string; sim: number }> = [];
    for (const prior of priors) {
      const sim = jaccard(draftShingles, shingles(bodyText(prior.body)));
      if (sim >= NEAR_DUPLICATE_THRESHOLD) dupes.push({ slug: prior.slug, sim });
    }
    dupes.sort((a, b) => b.sim - a.sim);

    if (dupes.length > 0) {
      siteIssues.push({
        key: "content.near_duplicate",
        dimension: "content",
        label: `Draft is a near-duplicate of ${dupes.length} existing post${dupes.length === 1 ? "" : "s"} on this site`,
        fix: "Rewrite to cover something the existing posts do not, or drop the keyword.",
        weight: Math.min(14, 4 + dupes.length * 3),
        count: dupes.length,
        samples: dupes.slice(0, 5).map((d) => `${(d.sim * 100).toFixed(0)}% — ${d.slug}`),
      });
      violations.push(
        `This draft repeats material already published on this blog: ${dupes
          .slice(0, 3)
          .map((d) => `"${d.slug}" (${(d.sim * 100).toFixed(0)}% overlap)`)
          .join(
            ", ",
          )}. Rewrite it so the argument, examples, and structure are genuinely different from those posts — do not simply reword the same sections.`,
      );
    }

    // Repeated openings. Every post on this blog comes from one system prompt
    // that mandates a fixed opening move, so this is the failure mode the
    // generator is most prone to.
    const draftIntro = introKey(draftText);
    if (draftIntro.length >= 60) {
      const sharedIntro = priors.filter((p) => introKey(bodyText(p.body)) === draftIntro);
      if (sharedIntro.length > 0) {
        siteIssues.push({
          key: "content.boilerplate_intro",
          dimension: "content",
          label: `Draft opens with the same first sentence as ${sharedIntro.length} existing post${sharedIntro.length === 1 ? "" : "s"}`,
          fix: "Write an opening specific to this topic.",
          weight: Math.min(8, 2 + sharedIntro.length * 2),
          count: sharedIntro.length,
          samples: sharedIntro.slice(0, 3).map((p) => p.slug),
        });
        violations.push(
          `The opening paragraph is identical to ${sharedIntro.length} post(s) already on this blog. Write a new opening built from this topic's own specifics.`,
        );
      }
    }
  }

  // --- 4. Score ------------------------------------------------------------
  const scored = { ...analyzed, issues: bodyIssues, points: bodyIssues.reduce((n, i) => n + i.weight, 0) };
  const score = slopScore([scored], siteIssues);

  if (score > maxScore) {
    violations.push(
      `Overall slop score is ${score}/100 (grade "${slopGrade(score)}"); this blog's ceiling is ${maxScore}. Address the issues above.`,
    );
  }

  return {
    ok: violations.length === 0,
    score,
    grade: slopGrade(score),
    issues: [...bodyIssues, ...siteIssues],
    violations,
    metrics: heuristics.metrics,
  };
}
