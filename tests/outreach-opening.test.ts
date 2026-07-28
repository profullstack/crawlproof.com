import { describe, it, expect } from "vitest";
import { extractRecipientContext, recipientContextPrompt } from "@/lib/outreach/recipientContext";
import { roleAddressGuesses, rankContacts, isNeverContactMailbox } from "@/lib/outreach/cold";
import { customDraftSystem } from "@/lib/outreach/pipeline";

describe("extractRecipientContext", () => {
  it("prefers a description over a bare brand name", () => {
    const html = `<title>Acme</title><meta name="description" content="Acme builds hard-surface 3D assets for game studios.">`;
    const ctx = extractRecipientContext(html);
    expect(ctx?.selfDescription).toMatch(/hard-surface 3D assets/);
    expect(ctx?.source).toBe("meta description");
  });

  it("ignores a title that is only a brand name", () => {
    // "Acme" supports no observation the domain didn't already give.
    expect(extractRecipientContext(`<title>Acme</title>`)).toBeNull();
  });

  it("accepts a title carrying a tagline", () => {
    const html = `<title>Acme — hard-surface 3D assets for game studios</title>`;
    expect(extractRecipientContext(html)?.selfDescription).toMatch(/hard-surface/);
  });

  it("rejects template boilerplate", () => {
    const html = `<meta name="description" content="Just another WordPress site for your business">`;
    expect(extractRecipientContext(html)).toBeNull();
  });

  it("decodes entities so the quote reads as written", () => {
    const html = `<meta name="description" content="Design &amp; build for founders who ship">`;
    expect(extractRecipientContext(html)?.selfDescription).toContain("Design & build");
  });
});

describe("recipientContextPrompt", () => {
  const ctx = { selfDescription: "We build hard-surface 3D assets.", source: "meta description" as const };

  it("quotes the site and forbids extending it", () => {
    const p = recipientContextPrompt(ctx, "acme.test");
    expect(p).toContain("We build hard-surface 3D assets.");
    expect(p).toMatch(/Do not extend it/);
  });

  it("bans flattery explicitly, since praise from a stranger is a form letter", () => {
    expect(recipientContextPrompt(ctx, "acme.test")).toMatch(/Flattery is not/);
  });

  it("tells the model it knows nothing when the site said nothing", () => {
    expect(recipientContextPrompt(null, "acme.test")).toMatch(/Nothing is known about them/);
  });
});

describe("customDraftSystem", () => {
  const system = customDraftSystem({
    intro: "Anthony, recruiting a graphics artist",
    ask: "take a look at the role",
    facts: ["The role is equity-only"],
  });

  it("asks for an observation rather than a compliment", () => {
    expect(system).toMatch(/observation, not a compliment/);
    expect(system).toMatch(/I love your work/);
  });

  it("refuses a subject line that promises what the body lacks", () => {
    // The email this was modelled on used "quick question" and asked none.
    expect(system).toMatch(/quick question/);
    expect(system).toMatch(/small lie/);
  });

  it("keeps the one small ask and no call", () => {
    expect(system).toMatch(/Never ask for a call in a first message/);
  });
});

describe("roleAddressGuesses", () => {
  it("guesses shared inboxes a small company plausibly reads", () => {
    const guesses = roleAddressGuesses("acme.test").map((c) => c.email);
    expect(guesses).toContain("hello@acme.test");
    expect(guesses).toContain("press@acme.test");
  });

  it("never guesses an address the never-contact list blocks", () => {
    // Guessing one would manufacture exactly the sends that list prevents.
    for (const c of roleAddressGuesses("acme.test")) {
      expect(isNeverContactMailbox(c.email), c.email).toBe(false);
    }
    expect(roleAddressGuesses("acme.test").map((c) => c.email)).not.toContain("careers@acme.test");
  });

  it("marks them as guesses so a human can tell", () => {
    expect(roleAddressGuesses("acme.test").every((c) => c.source === "guess")).toBe(true);
  });

  it("returns nothing for a non-domain", () => {
    expect(roleAddressGuesses("localhost")).toEqual([]);
  });

  it("ranks below any address the site actually published", () => {
    const ranked = rankContacts([
      ...roleAddressGuesses("acme.test"),
      { email: "someone@acme.test", source: "text", sameDomain: true },
    ]);
    expect(ranked[0].email).toBe("someone@acme.test");
  });
});
