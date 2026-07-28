import { describe, it, expect } from "vitest";
import {
  addressOf,
  decodeQuotedPrintable,
  isAutoReply,
  looksLikeResponse,
  parseHeaders,
  referencedMessageIds,
  scanSince,
  snippetOf,
} from "@/lib/outreach/replyScan";

const human = { headers: {}, subject: "Re: quick question", from: "jane@acme.test" };

describe("isAutoReply", () => {
  it("lets a real reply through", () => {
    expect(isAutoReply(human)).toBe(false);
  });

  it("catches RFC 3834 Auto-Submitted", () => {
    expect(isAutoReply({ ...human, headers: { "Auto-Submitted": "auto-replied" } })).toBe(true);
  });

  it("treats Auto-Submitted: no as the human it means", () => {
    // The spec's value for "a person sent this". Reading the header's mere
    // presence as automatic would discard every reply from a compliant client.
    expect(isAutoReply({ ...human, headers: { "Auto-Submitted": "no" } })).toBe(false);
  });

  it("catches the headers sent instead of implementing the spec", () => {
    for (const h of ["X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress"]) {
      expect(isAutoReply({ ...human, headers: { [h]: "yes" } })).toBe(true);
    }
    expect(isAutoReply({ ...human, headers: { Precedence: "bulk" } })).toBe(true);
  });

  it("catches a mailing list", () => {
    expect(isAutoReply({ ...human, headers: { "List-Id": "<dev.example.com>" } })).toBe(true);
  });

  it("catches out-of-office by subject", () => {
    const subjects = [
      "Out of Office",
      "Re: Out of the office until Monday",
      "Automatic reply: quick question",
      "Auto: I am away",
      "Undeliverable: quick question",
      "Delivery Status Notification (Failure)",
      "Thank you for contacting us",
    ];
    for (const subject of subjects) {
      expect(isAutoReply({ ...human, subject })).toBe(true);
    }
  });

  it("catches a bounce by sender", () => {
    for (const from of [
      "MAILER-DAEMON@acme.test",
      "postmaster@acme.test",
      "no-reply@acme.test",
      "noreply@acme.test",
    ]) {
      expect(isAutoReply({ ...human, from })).toBe(true);
    }
  });

  it("does not mistake a person for a robot", () => {
    // These sit near the patterns above without matching them, and each one is
    // a real prospect whose answer would otherwise be discarded.
    expect(isAutoReply({ ...human, from: "norbert@acme.test" })).toBe(false);
    expect(isAutoReply({ ...human, subject: "Re: your office move" })).toBe(false);
    expect(isAutoReply({ ...human, subject: "Thanks — can we talk Thursday?" })).toBe(false);
  });
});

describe("parseHeaders", () => {
  it("reads a header block case-insensitively", () => {
    expect(parseHeaders("Auto-Submitted: auto-replied\r\nPrecedence: bulk")).toEqual({
      "auto-submitted": "auto-replied",
      precedence: "bulk",
    });
  });

  it("joins folded continuation lines", () => {
    // Long References lists arrive wrapped; treating the continuation as a
    // new header loses the tail of the value.
    const parsed = parseHeaders("References: <a@x>\r\n <b@x>\r\n\t<c@x>");
    expect(parsed.references).toBe("<a@x> <b@x> <c@x>");
  });

  it("survives junk", () => {
    expect(parseHeaders("not a header\r\n\r\nX: 1")).toEqual({ x: "1" });
  });
});

describe("snippetOf", () => {
  it("stops at the quoted original", () => {
    // Nearly every reply carries a copy of what we sent, and an excerpt of our
    // own outreach says nothing about the answer.
    const body = "Sure, Thursday works.\n\nOn Tue, 28 Jul 2026, Anthony wrote:\n> our pitch here";
    expect(snippetOf(body)).toBe("Sure, Thursday works.");
  });

  it("stops at a bare quote marker", () => {
    expect(snippetOf("Interested.\n> original")).toBe("Interested.");
  });

  it("stops at Outlook's quoting style", () => {
    const body = "Yes please.\n\nFrom: anthony@crawlproof.com\nSent: Tuesday";
    expect(snippetOf(body)).toBe("Yes please.");
  });

  it("strips markup from an HTML-only reply", () => {
    expect(snippetOf("<div><p>Happy to chat.</p></div>")).toBe("Happy to chat.");
  });

  it("is bounded", () => {
    expect(snippetOf("x".repeat(5000)).length).toBeLessThanOrEqual(280);
  });
});

describe("addressOf", () => {
  it("pulls the address out of a display name", () => {
    expect(addressOf("Jane Doe <Jane@Acme.test>")).toBe("jane@acme.test");
  });

  it("passes a bare address through", () => {
    expect(addressOf(" Jane@Acme.test ")).toBe("jane@acme.test");
  });

  it("has nothing to say about nothing", () => {
    expect(addressOf(null)).toBe("");
  });
});

describe("scanSince", () => {
  const now = new Date("2026-07-28T12:00:00Z");

  it("looks back a fortnight on a first scan", () => {
    // Not the whole mailbox: a first scan of ten years of mail would time out
    // and match nothing, since none of it predates the campaign.
    const since = scanSince(null, now);
    expect(Math.round((now.getTime() - since.getTime()) / 86_400_000)).toBe(14);
  });

  it("overlaps the previous scan by a day", () => {
    // IMAP SINCE has date granularity, so a reply landing mid-scan would fall
    // into the gap between two runs.
    const last = new Date("2026-07-28T11:00:00Z");
    expect(scanSince(last, now).getTime()).toBe(last.getTime() - 86_400_000);
  });
});

describe("a reply has to look like one", () => {
  // The first live run against a real mailbox counted a Huntress marketing
  // blast as a reply: it came from a contacted domain, from a plausible
  // address, and matched on domain alone. Every case here is drawn from that
  // message's actual headers.
  const blast = {
    headers: {
      "List-Unsubscribe": "<mailto:x@bf02x.hubspotemail.net>",
      "Feedback-ID": "aecl4ke:aig3kzw8:aib1s:HubSpot",
    },
    subject: "Here’s what hackers can expect",
    from: "marketing@huntress.com",
  };

  it("flags bulk mail as automatic", () => {
    expect(isAutoReply(blast)).toBe(true);
  });

  it("flags List-Unsubscribe on its own", () => {
    // The single most reliable marker that something is a mailing rather than
    // a message: no human writing to one person adds an unsubscribe link.
    expect(
      isAutoReply({ headers: { "List-Unsubscribe": "<https://x.test/u>" }, subject: "Hi", from: "a@b.test" }),
    ).toBe(true);
  });

  it("does not read a marketing subject as a response", () => {
    expect(looksLikeResponse(blast)).toBe(false);
  });

  it("reads a Re: subject as a response", () => {
    expect(looksLikeResponse({ headers: {}, subject: "Re: quick question" })).toBe(true);
  });

  it("reads threading headers as a response even without Re:", () => {
    // Some clients rewrite the subject entirely; the header is the fact.
    expect(looksLikeResponse({ headers: { "In-Reply-To": "<a@x>" }, subject: "Thursday?" })).toBe(
      true,
    );
  });

  it("accepts the non-English Re: prefixes", () => {
    for (const s of ["AW: Frage", "SV: spørsmål", "Antw: vraag"]) {
      expect(looksLikeResponse({ headers: {}, subject: s })).toBe(true);
    }
  });
});

describe("referencedMessageIds", () => {
  it("collects ids from both threading headers", () => {
    expect(
      referencedMessageIds({ "In-Reply-To": "<a@x>", References: "<b@x> <c@x>" }),
    ).toEqual(["a@x", "b@x", "c@x"]);
  });

  it("has nothing to say about a fresh message", () => {
    expect(referencedMessageIds({ Subject: "hi" })).toEqual([]);
  });
});

describe("decodeQuotedPrintable", () => {
  it("decodes a multi-byte character as one character", () => {
    // Decoding each byte separately is how "…" becomes three mojibake glyphs.
    expect(decodeQuotedPrintable("threats=E2=80=A6and so many")).toBe("threats…and so many");
  });

  it("joins soft line breaks", () => {
    expect(decodeQuotedPrintable("can be a=\r\nvoided")).toBe("can be avoided");
  });

  it("leaves plain text alone", () => {
    expect(decodeQuotedPrintable("nothing to do here")).toBe("nothing to do here");
  });

  it("reaches the snippet", () => {
    expect(snippetOf("threats=E2=80=A6and more")).toBe("threats…and more");
  });
});
