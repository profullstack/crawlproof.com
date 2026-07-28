import { describe, it, expect } from "vitest";
import { scoreIntent, recencyFactor, qualifies, describeIntent, DEFAULT_MIN_INTENT } from "@/lib/outreach/intent";
import { parseResultDate, buildIntentQuery, INTENT_SOURCES } from "@/lib/outreach/intentSources";

const NOW = new Date("2026-07-28T12:00:00Z");
const agoHours = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const kw = ["load testing"];

const score = (text: string, hours = 2) =>
  scoreIntent({ text, postedAt: agoHours(hours), keywords: kw, now: NOW });

describe("what counts as intent", () => {
  it("ranks money on the table highest", () => {
    const s = score("Anyone know a good load testing service? Willing to pay.");
    expect(s.tier).toBe("purchase");
    expect(s.score).toBeGreaterThan(70);
  });

  it("treats leaving a supplier as strong intent", () => {
    // The budget exists and the decision to spend it has been made.
    const s = score("We're migrating away from our load testing vendor.");
    expect(s.tier).toBe("switching");
    expect(s.score).toBeGreaterThan(50);
  });

  it("recognises a plain request for a recommendation", () => {
    expect(score("Can anyone recommend a load testing tool?").tier).toBe("solicitation");
  });

  it("scores a bare complaint lowest of the four", () => {
    const pain = score("Struggling with our load testing setup again.");
    const ask = score("Can anyone recommend a load testing tool?");
    expect(pain.tier).toBe("pain");
    expect(pain.score).toBeLessThan(ask.score);
  });

  it("says plainly when nobody asked for anything", () => {
    // A statement is not an invitation, and this is the case the whole
    // feature exists to separate out.
    const s = score("Here is our quarterly load testing report.");
    expect(s.tier).toBe("none");
    expect(s.score).toBe(0);
    expect(s.reasons.join(" ")).toMatch(/nobody asked/);
  });
});

describe("recency is half the signal", () => {
  it("decays with age", () => {
    const fresh = score("Willing to pay for load testing help", 1);
    const old = score("Willing to pay for load testing help", 24 * 7);
    expect(fresh.score).toBeGreaterThan(old.score * 2);
  });

  it("halves at the half-life", () => {
    expect(recencyFactor(36)).toBeCloseTo(0.5, 2);
    expect(recencyFactor(72)).toBeCloseTo(0.25, 2);
  });

  it("gives up entirely on something ancient", () => {
    const s = score("Willing to pay for load testing", 24 * 30);
    expect(s.score).toBe(0);
    expect(s.disqualified).toMatch(/older than/);
  });

  it("penalises an undated source rather than assuming it is fresh", () => {
    // Most scraped directory entries have no date. Treating them as new would
    // rank them above a real post from yesterday.
    const undated = scoreIntent({ text: "Willing to pay for load testing", keywords: kw, now: NOW });
    const fresh = score("Willing to pay for load testing", 1);
    expect(undated.score).toBeLessThan(fresh.score);
    expect(undated.reasons.join(" ")).toMatch(/no date/);
  });
});

describe("intent for somebody else is not a lead", () => {
  it("drops a perfect request about the wrong topic", () => {
    // "Anyone recommend a good accountant, happy to pay" is flawless
    // solicitation and worthless to a company selling load testing.
    const s = scoreIntent({
      text: "Anyone recommend a good accountant? Happy to pay.",
      postedAt: agoHours(1),
      keywords: kw,
      now: NOW,
    });
    expect(s.disqualified).toMatch(/no campaign keyword/);
  });

  it("honours the campaign's negative keywords", () => {
    const s = scoreIntent({
      text: "Anyone recommend free load testing for a student project?",
      postedAt: agoHours(1),
      keywords: kw,
      negativeKeywords: ["student"],
      now: NOW,
    });
    expect(s.disqualified).toMatch(/negative match/);
  });
});

describe("people who said not to pitch them", () => {
  it("refuses someone who asked not to be pitched", () => {
    // The fastest way to lose a channel for everyone is to message the person
    // who wrote this.
    for (const text of [
      "Looking for load testing advice. No vendors please.",
      "Need load testing help — please don't DM me.",
      "Load testing, free only, not looking to pay",
    ]) {
      expect(scoreIntent({ text, postedAt: agoHours(1), keywords: kw, now: NOW }).disqualified).toBeTruthy();
    }
  });

  it("does not mistake a job ad for a buyer", () => {
    const s = score("We're hiring a load testing engineer, budget approved.");
    expect(s.disqualified).toMatch(/job ad/);
  });
});

describe("qualifying against a campaign's bar", () => {
  it("lets everything through when no bar is set", () => {
    // Turning the feature on must not silently empty an existing pipeline.
    const weak = score("Struggling with load testing", 24 * 5);
    expect(qualifies(weak, null)).toBe(true);
    expect(qualifies(weak, undefined)).toBe(true);
  });

  it("holds a weak signal below the bar", () => {
    expect(qualifies(score("Struggling with load testing", 24 * 6), DEFAULT_MIN_INTENT)).toBe(false);
  });

  it("passes a fresh explicit request", () => {
    expect(qualifies(score("Anyone recommend a load testing tool?", 2), DEFAULT_MIN_INTENT)).toBe(true);
  });

  it("never qualifies a disqualified signal, whatever the bar", () => {
    const blocked = scoreIntent({ text: "load testing, no vendors", postedAt: agoHours(1), keywords: kw, now: NOW });
    expect(qualifies(blocked, 0)).toBe(false);
  });

  it("explains itself in one line", () => {
    expect(describeIntent(score("Willing to pay for load testing", 1))).toMatch(/purchase/);
  });
});

describe("reading dates off a search index", () => {
  it("parses a relative date", () => {
    expect(parseResultDate("3 hours ago", NOW)?.toISOString()).toBe("2026-07-28T09:00:00.000Z");
  });

  it("parses an absolute date", () => {
    expect(parseResultDate("Jul 20, 2026", NOW)?.getUTCDate()).toBe(20);
  });

  it("rejects a date from the future", () => {
    // The index misreporting, not a scoop.
    expect(parseResultDate("Jan 1, 2030", NOW)).toBeNull();
  });

  it("has nothing to say when the index gives no date", () => {
    expect(parseResultDate(null, NOW)).toBeNull();
    expect(parseResultDate("sometime", NOW)).toBeNull();
  });
});

describe("searching more than one platform", () => {
  it("covers more than Reddit", () => {
    // A pipeline that watches one community inherits its demographics as the
    // entire market.
    expect(INTENT_SOURCES.length).toBeGreaterThan(4);
    expect(INTENT_SOURCES.some((s) => s.id === "reddit")).toBe(true);
    expect(INTENT_SOURCES.some((s) => s.sites.some((x) => x.includes("linkedin")))).toBe(true);
  });

  it("restricts a search to its own sites", () => {
    const q = buildIntentQuery({
      source: INTENT_SOURCES[0],
      topic: "load testing",
      phrasing: '"anyone recommend"',
    });
    expect(q).toContain("site:reddit.com");
    expect(q).toContain("load testing");
  });
});

describe("buyers and decision makers, not people selling", () => {
  // The target is whoever can authorise a purchase. The inverse — somebody
  // advertising their own availability — uses the same vocabulary about the
  // same topic with the same enthusiasm, and scored identically until this.
  it("refuses a freelancer advertising themselves", () => {
    for (const text of [
      "Experienced load testing consultant, available for hire.",
      "I do load testing work — DM me for rates.",
      "Load testing specialist, open to work. My portfolio is here.",
      "Taking on new clients for load testing this quarter.",
      "#OpenToWork — load testing and performance engineering.",
    ]) {
      const s = scoreIntent({ text, postedAt: agoHours(1), keywords: kw, now: NOW });
      expect(s.disqualified).toBeTruthy();
    }
  });

  it("refuses someone looking for a job rather than a supplier", () => {
    const s = score("Looking for a job doing load testing.");
    expect(s.disqualified).toMatch(/looking for work/);
  });

  it("still accepts a company engaging a firm", () => {
    // Buying a service, which is a purchase — unlike taking on an employee.
    const s = score("We're looking to hire an agency for our load testing.");
    expect(s.disqualified).toBeNull();
    expect(s.tier).toBe("purchase");
  });

  it("does not treat employing a person as a purchase", () => {
    const s = score("We're hiring a load testing engineer.");
    expect(s.disqualified).toMatch(/job ad/);
  });
});

describe("authority separates a buyer from a bystander", () => {
  it("ranks the person who can sign above the one who cannot", () => {
    const buyer = score("We're evaluating load testing tools for our team this quarter.");
    const bystander = score("Anyone know a good load testing tool?");
    expect(buyer.score).toBeGreaterThan(bystander.score);
    expect(buyer.decisionMaker).toBe(true);
    expect(bystander.decisionMaker).toBe(false);
  });

  it("recognises a stated role", () => {
    const s = score("I'm the CTO and we need load testing. Any recommendations?");
    expect(s.decisionMaker).toBe(true);
    expect(s.reasons.join(" ")).toMatch(/decision-making role/);
  });

  it("recognises procurement language", () => {
    expect(score("Load testing vendor review — we need a shortlist.").decisionMaker).toBe(true);
  });

  it("does not manufacture intent from a job title alone", () => {
    // Authority is added to an ask, never multiplied by it. Someone who can
    // sign but has not asked for anything is not a lead.
    const s = score("I'm the CTO of a company that does load testing.");
    expect(s.tier).toBe("none");
    expect(s.score).toBe(0);
  });

  it("caps the bonus so authority cannot outweigh asking", () => {
    const loaded = score(
      "I'm the CTO, our team is evaluating, we need this, procurement approved — struggling with load testing.",
    );
    const plainAsk = score("Willing to pay for load testing help.");
    // A pile of authority markers on a mere complaint must not beat a real
    // offer of money.
    expect(loaded.score).toBeLessThanOrEqual(plainAsk.score);
  });
});

describe("where it looks for buyers", () => {
  it("no longer trawls freelance marketplaces", () => {
    // Dense with the inverse of a lead: people selling, not buying.
    const sites = INTENT_SOURCES.flatMap((s) => s.sites);
    for (const board of ["upwork.com", "remoteok.com", "weworkremotely.com"]) {
      expect(sites).not.toContain(board);
    }
  });

  it("watches sites where buyers compare vendors", () => {
    const sites = INTENT_SOURCES.flatMap((s) => s.sites);
    expect(sites.some((s) => ["g2.com", "trustradius.com", "capterra.com"].includes(s))).toBe(true);
  });
});
