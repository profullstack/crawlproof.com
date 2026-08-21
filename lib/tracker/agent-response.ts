import { NextResponse } from "next/server";
import type { AgentDecision } from "./agent-gate";

/**
 * What a throttled or banned agent is told.
 *
 * The tracker answers everything else with a bare 204, deliberately: a beacon
 * has nothing to say and a body is wasted bytes on every page view on the
 * internet. This is the one case where silence is the wrong answer. An operator
 * whose crawler is being refused has no way to find out why, or what to do about
 * it, unless we say so -- and "pay for access" is not a thing anyone can guess.
 *
 * So the FIRST refusal in each backoff period carries the terms. Subsequent ones
 * inside the same period are a bare 429 with Retry-After, because repeating a
 * paragraph to a crawler that is not reading it is just more traffic.
 *
 * 429 rather than 402. Payment Required is semantically closer and it is what
 * this is really about, but almost no crawler implements it, whereas every
 * serious one backs off on 429 and honours Retry-After. Being understood beats
 * being right.
 */
export function refuse(decision: Extract<AgentDecision, { action: "ban" | "throttle" }>) {
  const headers: Record<string, string> = {
    "retry-after": String(decision.retryAfterSeconds),
    "cache-control": "no-store",
    // Machine-readable pointer for anything that reads links but not bodies.
    link: '<https://crawlproof.com/crawlers>; rel="terms-of-service"',
    "x-crawlproof-action": decision.action,
  };

  if (!decision.notify) {
    return new NextResponse(null, { status: 429, headers });
  }

  return NextResponse.json(
    {
      error: decision.action === "ban" ? "agent_banned" : "rate_limited",
      message: decision.reason,
      retry_after_seconds: decision.retryAfterSeconds,
      user_agent: decision.userAgent,
      /*
       * Written to be read by a human who has been paged at 3am because their
       * crawler started getting 429s, and who has never heard of us. Tell them
       * what happened, what to do, and how to reach somebody.
       */
      what_this_means:
        "This site meters automated traffic. Your requests are being rate limited, not blocked at the origin.",
      how_to_resolve: [
        "Slow down: honour the Retry-After header and stay under the published limit.",
        "Identify yourself: use a stable User-Agent with a contact URL so the site owner can reach you.",
        "Buy access: paid crawlers get a higher limit and are exempt from backoff.",
      ],
      pricing_url: "https://crawlproof.com/crawlers",
      contact_url: "https://crawlproof.com/contact",
    },
    { status: 429, headers },
  );
}
