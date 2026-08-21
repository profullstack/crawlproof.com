import { describe, expect, it } from "vitest";
import {
  agentKeyOf,
  backoffMs,
  DEFAULT_HOURLY_LIMIT,
  ruleMatches,
  truncateAgent,
} from "@/lib/tracker/agent-gate";

/**
 * The pure half of the agent gate.
 *
 * The database half falls open on any error by design, so what is worth pinning
 * here is the identity and matching logic: an agent that can rename itself every
 * request can never be rate limited, and a rule that matches too eagerly bans a
 * customer's real visitors.
 */

describe("collapsing an agent to something countable", () => {
  it("strips version numbers so a crawler cannot reset its own counter", () => {
    // The attack this exists for: append a build number to every request and
    // every request looks like a new agent, so no window ever fills.
    const a = agentKeyOf("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)");
    const b = agentKeyOf("Mozilla/5.0 (compatible; GPTBot/1.3; +https://openai.com/gptbot)");
    expect(a).toBe(b);
  });

  it("strips long digit runs, which is where build ids and timestamps hide", () => {
    expect(agentKeyOf("Crawler build 20260821164500")).toBe(
      agentKeyOf("Crawler build 20260821170000"),
    );
  });

  it("still tells genuinely different agents apart", () => {
    expect(agentKeyOf("GPTBot/1.0")).not.toBe(agentKeyOf("ClaudeBot/1.0"));
    expect(agentKeyOf("Mozilla/5.0 (Macintosh) Safari")).not.toBe(agentKeyOf("curl/8.5.0"));
  });

  it("is case and whitespace insensitive", () => {
    expect(agentKeyOf("  GPTBot/1.0  ")).toBe(agentKeyOf("gptbot/1.0"));
  });

  it("survives a missing agent", () => {
    expect(agentKeyOf(null)).toBe("(none)");
    expect(agentKeyOf("")).toBe("(none)");
  });
});

describe("bounding what gets stored", () => {
  it("truncates rather than rejects, because the prefix identifies it", () => {
    const long = `GPTBot ${"x".repeat(2000)}`;
    expect(truncateAgent(long)!.length).toBe(512);
    expect(truncateAgent(long)!.startsWith("GPTBot")).toBe(true);
  });

  it("keeps null as null rather than inventing an empty agent", () => {
    expect(truncateAgent(null)).toBeNull();
    expect(truncateAgent("   ")).toBeNull();
  });
});

describe("matching a rule against an agent", () => {
  const ua = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";

  it("contains is case-insensitive and is the common case", () => {
    expect(ruleMatches(ua, "gptbot", "contains")).toBe(true);
    expect(ruleMatches(ua, "GPTBot", "contains")).toBe(true);
    expect(ruleMatches(ua, "claudebot", "contains")).toBe(false);
  });

  it("exact means exact", () => {
    expect(ruleMatches("curl/8.5.0", "curl/8.5.0", "exact")).toBe(true);
    expect(ruleMatches(ua, "gptbot", "exact")).toBe(false);
  });

  it("regex works, and a broken one matches nothing instead of throwing", () => {
    expect(ruleMatches(ua, "gpt(bot|crawler)", "regex")).toBe(true);
    // An unbalanced group would take the whole ingest down if it escaped.
    expect(ruleMatches(ua, "gpt(bot", "regex")).toBe(false);
  });

  it("an empty pattern never matches, so a blank row cannot ban everyone", () => {
    expect(ruleMatches(ua, "", "contains")).toBe(false);
    expect(ruleMatches(ua, "   ", "contains")).toBe(false);
  });
});

describe("exponential backoff", () => {
  it("doubles per consecutive offending window", () => {
    expect(backoffMs(0)).toBe(5 * 60 * 1000);
    expect(backoffMs(1)).toBe(10 * 60 * 1000);
    expect(backoffMs(2)).toBe(20 * 60 * 1000);
    expect(backoffMs(3)).toBe(40 * 60 * 1000);
  });

  it("is capped at a day", () => {
    // Past a day a throttle is indistinguishable from a ban and reads as broken
    // to whoever is on the other end.
    expect(backoffMs(50)).toBe(24 * 60 * 60 * 1000);
    expect(backoffMs(10)).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("never goes negative on a nonsense strike count", () => {
    expect(backoffMs(-5)).toBe(5 * 60 * 1000);
  });
});

describe("the default limit is a rate a human cannot reach", () => {
  it("is well above real browsing and well below the bot we caught", () => {
    // The crawler that prompted this ran at 7.5 pages/minute, or 450/hour, and
    // sat just under a 600/hour default. A person does not read 600 pages in an
    // hour, so the default catches abuse without touching anybody real.
    expect(DEFAULT_HOURLY_LIMIT).toBeGreaterThan(120);
    expect(DEFAULT_HOURLY_LIMIT).toBeLessThanOrEqual(1000);
  });
});
