import { describe, it, expect } from "vitest";
import { isNeverContactMailbox, rankContacts, suppressionReason } from "@/lib/outreach/cold";

// Every address in this first list actually received a live cold email before
// the guard covered it. They are kept verbatim rather than paraphrased,
// because the failure was that near-synonyms of listed words were not listed:
// `unsubscribe`, `privacy` and `legal` were all present while `optout` and
// `dpo` were not, and intent does not close that gap — enumeration does.
describe("addresses that leaked through and must not again", () => {
  const leaked = [
    "optout@dribbble.com",
    "dpo@ecoconsult.it",
    "candidate-accomodations@activisionblizzard.com",
  ];

  for (const email of leaked) {
    it(`never contacts ${email}`, () => {
      expect(isNeverContactMailbox(email)).toBe(true);
    });
  }
});

describe("categories that must never receive cold outreach", () => {
  const blocked = [
    // Opting out — mailing these is backwards.
    "unsubscribe@example.com",
    "opt-out@example.com",
    "removeme@example.com",
    // Data protection — a pitch here goes to whoever files the complaint.
    "privacy@example.com",
    "gdpr@example.com",
    "data-protection@example.com",
    "compliance@example.com",
    // Reporting and enforcement.
    "abuse@example.com",
    "phishing@example.com",
    "whistleblower@example.com",
    // Accessibility queues, including the common misspelling.
    "accessibility@example.com",
    "accommodations@example.com",
    "accomodations@example.com",
    "a11y@example.com",
    // Automated senders.
    "noreply@example.com",
    "mailer-daemon@example.com",
    "bounces@example.com",
    // Hiring queues.
    "careers@example.com",
    "recruiting@example.com",
    "admissions@example.com",
  ];

  for (const email of blocked) {
    it(`blocks ${email}`, () => {
      expect(isNeverContactMailbox(email)).toBe(true);
    });
  }

  it("reports it as a suppression reason, not a silent drop", () => {
    expect(
      suppressionReason({ email: "optout@example.com", suppressed: false }),
    ).toBe("never-contact-mailbox");
  });

  it("filters them out of ranked contacts entirely", () => {
    const ranked = rankContacts([
      { email: "optout@example.com", source: "mailto", sameDomain: true },
      { email: "jane@example.com", source: "mailto", sameDomain: true },
    ]);
    expect(ranked.map((c) => c.email)).toEqual(["jane@example.com"]);
  });
});

describe("addresses that are still fair game", () => {
  // Over-blocking costs real prospects. A shared business inbox is often the
  // only address a small company publishes, and is a legitimate B2B target —
  // unlike anything in the list above.
  const allowed = [
    "hello@example.com",
    "info@example.com",
    "contact@example.com",
    "support@example.com",
    "sales@example.com",
    "jane.doe@example.com",
    "j.smith@example.com",
    // Contains a blocked word but is not that mailbox.
    "privacyengineering@example.com",
    "careerscoach@example.com",
    "hrothgar@example.com",
  ];

  for (const email of allowed) {
    it(`allows ${email}`, () => {
      expect(isNeverContactMailbox(email)).toBe(false);
    });
  }
});
