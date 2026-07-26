import { describe, it, expect } from "vitest";
import {
  bestContact,
  discoverContactEmails,
  isNeverContactMailbox,
  looksLikeEmail,
  nextStepReadyAt,
  normalizeHost,
  outreachSubject,
  rankContacts,
  stepGuidance,
  suppressionReason,
  unsupportedClaims,
  type ProspectFacts,
} from "@/lib/outreach/cold";
import {
  extractOutboundProspects,
  isNonProspectHost,
} from "@/lib/outreach/discover";
import { parseDdgHtml, unwrapDdgUrl } from "@/lib/outreach/freeSearch";
import {
  candidateEmails,
  extractPhones,
  extractSocials,
  extractAddress,
  leadsToCsv,
} from "@/lib/outreach/enrich";
import { isWeakEnough } from "@/lib/outreach/pipeline";

function facts(over: Partial<ProspectFacts> = {}): ProspectFacts {
  return {
    host: "example.com",
    score: 42,
    kind: "aeo",
    topIssues: ["No meta description on the homepage", "Blocks GPTBot in robots.txt"],
    reportUrl: "https://crawlproof.com/r/tok123",
    quoteUsd: 1200,
    ...over,
  };
}

describe("suppressionReason", () => {
  const base = { email: "owner@example.com", suppressed: false };

  it("allows a normal prospect", () => {
    expect(suppressionReason({ ...base, sentToday: 0, dailyCap: 50 })).toBeNull();
  });

  it("blocks an address on the do-not-contact list", () => {
    expect(suppressionReason({ ...base, suppressed: true })).toBe("suppressed");
  });

  it("blocks someone who unsubscribed from any CrawlProof mail", () => {
    expect(suppressionReason({ ...base, unsubscribedAt: "2026-01-01T00:00:00Z" })).toBe("unsubscribed");
  });

  it("blocks our own domain", () => {
    expect(suppressionReason({ ...base, email: "anthony@crawlproof.com" })).toBe("internal");
  });

  it("blocks machine mailboxes but allows shared business inboxes", () => {
    expect(suppressionReason({ ...base, email: "noreply@example.com" })).toBe("never-contact-mailbox");
    expect(suppressionReason({ ...base, email: "postmaster@example.com" })).toBe("never-contact-mailbox");
    // info@/hello@ are exactly who a small business wants strangers to email.
    expect(suppressionReason({ ...base, email: "info@example.com" })).toBeNull();
    expect(suppressionReason({ ...base, email: "hello@example.com" })).toBeNull();
  });

  it("blocks a repeat of the same step", () => {
    expect(suppressionReason({ ...base, alreadyContacted: true })).toBe("already-contacted");
  });

  it("blocks at the daily cap", () => {
    expect(suppressionReason({ ...base, sentToday: 50, dailyCap: 50 })).toBe("daily-cap");
    expect(suppressionReason({ ...base, sentToday: 49, dailyCap: 50 })).toBeNull();
  });

  it("puts an explicit opt-out ahead of a mere cap", () => {
    expect(suppressionReason({ ...base, suppressed: true, sentToday: 999, dailyCap: 50 })).toBe("suppressed");
  });

  it("rejects a malformed address before anything else", () => {
    expect(suppressionReason({ ...base, email: "not-an-address" })).toBe("invalid-address");
  });
});

describe("looksLikeEmail / isNeverContactMailbox", () => {
  it("accepts ordinary addresses and rejects junk", () => {
    expect(looksLikeEmail("Jane.Doe@Example.COM")).toBe(true);
    expect(looksLikeEmail("jane@localhost")).toBe(false);
    expect(looksLikeEmail("logo@2x.png")).toBe(false);
  });

  it("treats abuse/security/legal as never-contact, not as sales targets", () => {
    for (const box of ["abuse", "security", "legal", "dmca", "privacy"]) {
      expect(isNeverContactMailbox(`${box}@example.com`)).toBe(true);
    }
    expect(isNeverContactMailbox("sales@example.com")).toBe(false);
  });
});

describe("discoverContactEmails", () => {
  const html = `
    <html><body>
      <a href="mailto:hello@example.com">Email us</a>
      <p>Accounts: billing@example.com</p>
      <p>Site by webdev@agency.io</p>
      <img src="logo@2x.png">
      <script>var cfg = {contact:"tracker@vendor-analytics.com"}</script>
    </body></html>`;

  it("finds published addresses and marks off-domain ones", () => {
    const found = discoverContactEmails(html, "example.com");
    const emails = found.map((f) => f.email);
    expect(emails).toContain("hello@example.com");
    expect(emails).toContain("billing@example.com");
    expect(found.find((f) => f.email === "webdev@agency.io")?.sameDomain).toBe(false);
  });

  it("ignores addresses buried in script config blobs", () => {
    const emails = discoverContactEmails(html, "example.com").map((f) => f.email);
    expect(emails).not.toContain("tracker@vendor-analytics.com");
  });

  it("ignores asset filenames that happen to match the address shape", () => {
    const emails = discoverContactEmails(html, "example.com").map((f) => f.email);
    expect(emails.some((e) => e.endsWith(".png"))).toBe(false);
  });

  it("prefers the prospect's own domain over their web developer", () => {
    const best = bestContact(discoverContactEmails(html, "example.com"));
    expect(best?.email.endsWith("@example.com")).toBe(true);
  });

  it("ranks a named human above a shared inbox", () => {
    const ranked = rankContacts([
      { email: "info@example.com", source: "mailto", sameDomain: true },
      { email: "sarah@example.com", source: "text", sameDomain: true },
    ]);
    expect(ranked[0].email).toBe("sarah@example.com");
  });
});

describe("outreachSubject", () => {
  it("states the score on first contact", () => {
    expect(outreachSubject(facts(), 1)).toContain("42/100");
  });

  it("flips the wording for the slop dial, where high is bad", () => {
    expect(outreachSubject(facts({ kind: "slop", score: 71 }), 1)).toContain("carelessness");
  });

  it("closes the loop on the final step without pitching", () => {
    const subject = outreachSubject(facts(), 3);
    expect(subject).toBe("Last note about example.com");
  });
});

describe("unsupportedClaims", () => {
  it("passes a draft that only states what the report found", () => {
    const body = "Your homepage has no meta description, and robots.txt blocks GPTBot. Full report attached.";
    expect(unsupportedClaims(body, facts())).toEqual([]);
  });

  it("catches a score the report doesn't have", () => {
    expect(unsupportedClaims("You scored 63/100.", facts({ score: null }))).toHaveLength(1);
  });

  it("catches a score that contradicts the report", () => {
    const problems = unsupportedClaims("You scored 63/100 on our scan.", facts({ score: 42 }));
    expect(problems[0]).toContain("42/100");
  });

  it("catches invented familiarity", () => {
    const problems = unsupportedClaims("Great speaking with you last week!", facts());
    expect(problems.some((p) => p.includes("prior relationship"))).toBe(true);
  });

  it("catches a reference to a report that doesn't exist", () => {
    const problems = unsupportedClaims("See the full report.", facts({ reportUrl: null }));
    expect(problems.some((p) => p.includes("report"))).toBe(true);
  });
});

describe("sequence pacing", () => {
  it("holds step 2 for four days and step 3 for a week after that", () => {
    const sent = new Date("2026-07-01T12:00:00Z");
    expect(nextStepReadyAt(sent, 2).toISOString().slice(0, 10)).toBe("2026-07-05");
    expect(nextStepReadyAt(sent, 3).toISOString().slice(0, 10)).toBe("2026-07-08");
  });

  it("requires the follow-up to add new information", () => {
    expect(stepGuidance(2)).toMatch(/NEW information/i);
    expect(stepGuidance(3)).toMatch(/last message/i);
  });
});

describe("isWeakEnough", () => {
  it("pitches a low AEO score and skips a high one", () => {
    expect(isWeakEnough({ score: 40, engine: "rule", maxScore: 70 })).toBe(true);
    expect(isWeakEnough({ score: 85, engine: "rule", maxScore: 70 })).toBe(false);
  });

  it("inverts for slop, where a high score is the bad one", () => {
    expect(isWeakEnough({ score: 80, engine: "slop", maxScore: 70 })).toBe(true);
    expect(isWeakEnough({ score: 10, engine: "slop", maxScore: 70 })).toBe(false);
  });

  it("never pitches a site with no score", () => {
    expect(isWeakEnough({ score: null, engine: "rule", maxScore: 70 })).toBe(false);
  });
});

describe("discovery filters", () => {
  it("rejects platforms and aggregators as prospects", () => {
    for (const host of ["yelp.com", "facebook.com", "wikipedia.org", "g2.com", "squarespace.com"]) {
      expect(isNonProspectHost(host)).toBe(true);
    }
    expect(isNonProspectHost("smithdental.com")).toBe(false);
  });

  it("pulls business domains out of a directory page and skips its own links", () => {
    const html = `
      <a href="/about">About us</a>
      <a href="https://smithdental.com">Smith Dental</a>
      <a href="https://www.yelp.com/biz/smith">Yelp</a>
      <a href="https://brightsmiles.co/contact">Bright Smiles</a>
      <a href="https://directory.example/list.pdf">PDF</a>`;
    const found = extractOutboundProspects({ html, sourceUrl: "https://directory.example/dentists" });
    expect(found.map((f) => f.host)).toEqual(["smithdental.com", "brightsmiles.co"]);
    expect(found[0].label).toBe("Smith Dental");
  });
});

describe("DuckDuckGo parsing", () => {
  it("unwraps the redirect so results aren't all duckduckgo.com", () => {
    expect(unwrapDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fsmithdental.com%2F&rut=abc")).toBe(
      "https://smithdental.com/",
    );
  });

  it("parses names, urls and snippets out of the HTML endpoint", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsmithdental.com%2F">Smith Dental</a>
        <div class="result__snippet">Family dentistry in Miami.</div>
      </div>`;
    const results = parseDdgHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "Smith Dental", host: "smithdental.com" });
    expect(results[0].snippet).toContain("Miami");
  });
});

describe("enrichment extraction", () => {
  it("finds phone numbers without swallowing years", () => {
    const phones = extractPhones("Call (305) 555-0134 today. Founded 2019. Fax: 305.555.0199");
    expect(phones.some((p) => p.includes("555-0134"))).toBe(true);
    expect(phones).not.toContain("2019");
  });

  it("rejects the shapes that look like phone numbers on real pages", () => {
    // All three came out of a live scrape before the filter tightened:
    // an ISO date, a Japanese postal code, and a version/IP triple.
    const phones = extractPhones("Updated 2026-02-20. 〒150-0001 Tokyo. Build 22.121.209.");
    expect(phones).toEqual([]);
  });

  it("keeps an international number written with a country code", () => {
    expect(extractPhones("Reach us on +1 888 926 2289.")).toEqual(["+1 888 926 2289"]);
  });

  it("finds social profiles and skips share widgets", () => {
    const socials = extractSocials(
      `<a href="https://www.linkedin.com/company/smith-dental">in</a>
       <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
       <a href="https://instagram.com/smithdental">ig</a>`,
    );
    expect(socials.linkedin).toContain("smith-dental");
    expect(socials.instagram).toContain("smithdental");
    expect(socials.facebook).toBeUndefined();
  });

  it("prefers a structured postal address over prose", () => {
    const html = `<script type="application/ld+json">{"address":{"streetAddress":"12 Main St","addressLocality":"Miami","addressRegion":"FL","postalCode":"33101"}}</script>`;
    expect(extractAddress(html)).toBe("12 Main St, Miami, FL, 33101");
  });

  it("falls back to an address element", () => {
    expect(extractAddress("<address>400 Ocean Drive, Miami FL</address>")).toContain("Ocean Drive");
  });
});

describe("email_find candidates", () => {
  it("ranks first.last ahead of firstlast", () => {
    const guesses = candidateEmails({ firstName: "Jane", lastName: "Doe", domain: "acme.com" });
    expect(guesses[0].email).toBe("jane.doe@acme.com");
    const order = guesses.map((g) => g.pattern);
    expect(order.indexOf("first.last")).toBeLessThan(order.indexOf("firstlast"));
  });

  it("strips accents and punctuation from names", () => {
    const guesses = candidateEmails({ firstName: "José", lastName: "O'Neill-Smith", domain: "acme.com" });
    expect(guesses[0].email).toBe("jose.oneillsmith@acme.com");
  });

  it("returns nothing without both names", () => {
    expect(candidateEmails({ firstName: "", lastName: "Doe", domain: "acme.com" })).toEqual([]);
  });
});

describe("csv export", () => {
  it("quotes cells containing commas and quotes", () => {
    const csv = leadsToCsv([{ host: "a.com", note: 'Smith, "Bob"' }]);
    expect(csv.split("\n")[1]).toBe('a.com,"Smith, ""Bob"""');
  });

  it("flattens array columns instead of dropping them", () => {
    const csv = leadsToCsv([{ host: "a.com", issues: ["x", "y"] }]);
    expect(csv).toContain("x | y");
  });
});

describe("normalizeHost", () => {
  it("strips scheme, www and path", () => {
    expect(normalizeHost("https://www.Example.com/contact")).toBe("example.com");
    expect(normalizeHost("example.com")).toBe("example.com");
  });
});
