import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

const VALUE_PROP_KEYWORDS = [
  "we help",
  "platform for",
  "the easiest way",
  "trusted by",
  "built for",
];

export function checkPositioning(ctx: CrawlContext): Finding[] {
  const out: Finding[] = [];
  const home = ctx.pages[ctx.target];
  if (!home?.rawHtml) return out;

  const $ = cheerio.load(home.rawHtml);
  const text = (home.renderedText ?? $.root().text()).toLowerCase();
  const links = $("a[href]").map((_, el) => ({
    href: ($(el).attr("href") ?? "").trim(),
    text: $(el).text().trim().toLowerCase(),
  })).get();

  function hasLinkLike(re: RegExp) {
    return links.some((l) => re.test(l.href) || re.test(l.text));
  }

  // Who they are
  const aboutLinked = hasLinkLike(/about|company|team/i);
  out.push({
    section: "Positioning Clarity",
    check_key: "positioning.who",
    status: aboutLinked ? "pass" : "warn",
    title: aboutLinked ? "About/Team path discoverable" : "No clear About/Team link",
    detail: aboutLinked ? undefined : "Add an About or Team link in the nav or footer so LLMs can identify the company.",
    priority: aboutLinked ? 5 : 2,
  });

  // What they do
  const h1 = $("h1").first().text().trim();
  const hasMeaningfulH1 = h1.length >= 8;
  out.push({
    section: "Positioning Clarity",
    check_key: "positioning.what",
    status: hasMeaningfulH1 ? "pass" : "warn",
    title: hasMeaningfulH1 ? "H1 communicates value" : "H1 missing or too short to convey value",
    detail: h1 || "Add a clear, single-sentence H1 like 'We help X do Y.'",
    priority: hasMeaningfulH1 ? 5 : 1,
  });

  // Who it serves / why different
  const hasValueProp = VALUE_PROP_KEYWORDS.some((k) => text.includes(k));
  out.push({
    section: "Positioning Clarity",
    check_key: "positioning.audience",
    status: hasValueProp ? "pass" : "warn",
    title: hasValueProp ? "Value-prop language detected" : "Value-prop language not detected",
    detail: hasValueProp
      ? undefined
      : "Pages with phrases like 'we help X', 'platform for Y', 'built for Z' are easier for LLMs to summarize.",
    priority: hasValueProp ? 5 : 3,
  });

  // Pricing path
  const pricingLinked = hasLinkLike(/pricing|plans/i);
  out.push({
    section: "Positioning Clarity",
    check_key: "positioning.pricing",
    status: pricingLinked ? "pass" : "warn",
    title: pricingLinked ? "Pricing path discoverable" : "No pricing/plans link found",
    detail: pricingLinked
      ? undefined
      : "AI summaries commonly include pricing. Add a /pricing page even if pricing is custom.",
    priority: pricingLinked ? 5 : 2,
  });

  // Contact / signup / demo
  const signupLinked = hasLinkLike(/contact|sales|demo|signup|sign[-\s]?up|get[-\s]?started|try|book/i);
  out.push({
    section: "Positioning Clarity",
    check_key: "positioning.cta",
    status: signupLinked ? "pass" : "fail",
    title: signupLinked ? "Contact / signup path discoverable" : "No discoverable CTA",
    detail: signupLinked
      ? undefined
      : "Add a clearly-labeled Contact, Demo, or Sign up link to the nav or hero.",
    priority: signupLinked ? 5 : 1,
  });

  return out;
}
