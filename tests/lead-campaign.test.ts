import { describe, it, expect } from "vitest";
import {
  campaignSubject,
  excludeReason,
  hireUrlFor,
  selectRecipients,
  type LeadRow,
} from "@/lib/leadCampaign";

function lead(over: Partial<LeadRow> = {}): LeadRow {
  return {
    email: "person@example.com",
    host: "example.com",
    reportToken: "tok123456",
    score: 54,
    scoreLabel: "AEO Score",
    scaleHint: "out of 100 · higher is better",
    topIssues: ["Blocks GPTBot", "No structured data"],
    isCustomer: false,
    unsubscribedAt: null,
    consentedAt: null,
    ...over,
  };
}

describe("excludeReason", () => {
  it("sends to a plain lead with a report", () => {
    expect(excludeReason(lead(), "all")).toBeNull();
  });

  it("never mails an unsubscribed address", () => {
    expect(excludeReason(lead({ unsubscribedAt: "2026-01-01" }), "all")).toBe("unsubscribed");
  });

  it("lets unsubscribe beat a later consent record", () => {
    // If both are set the safe reading is that they want out. Getting this
    // backwards is the single most expensive bug in a sending system.
    const row = lead({ unsubscribedAt: "2026-02-01", consentedAt: "2026-03-01" });
    expect(excludeReason(row, "all")).toBe("unsubscribed");
  });

  it("skips our own addresses", () => {
    expect(excludeReason(lead({ email: "anthony@profullstack.com" }), "all")).toBe("internal");
    expect(excludeReason(lead({ email: "x@crawlproof.com" }), "all")).toBe("internal");
  });

  it("skips role accounts that aren't a person", () => {
    for (const e of ["postmaster@x.com", "no-reply@x.com", "abuse@x.com"]) {
      expect(excludeReason(lead({ email: e }), "all")).toBe("role-account");
    }
  });

  it("skips anyone with no report to talk about", () => {
    // The whole email is about their scan; without one it's a generic blast.
    expect(excludeReason(lead({ reportToken: null }), "all")).toBe("no-report");
  });
});

describe("segments", () => {
  it("'users' keeps only existing customers", () => {
    expect(excludeReason(lead({ isCustomer: true }), "users")).toBeNull();
    expect(excludeReason(lead({ isCustomer: false }), "users")).toBe("wrong-segment");
  });

  it("'leads' keeps only non-customers", () => {
    expect(excludeReason(lead({ isCustomer: false }), "leads")).toBeNull();
    expect(excludeReason(lead({ isCustomer: true }), "leads")).toBe("wrong-segment");
  });

  it("'all' keeps both", () => {
    expect(excludeReason(lead({ isCustomer: true }), "all")).toBeNull();
    expect(excludeReason(lead({ isCustomer: false }), "all")).toBeNull();
  });
});

describe("selectRecipients", () => {
  it("mails an address once even if it scanned several sites", () => {
    const { send } = selectRecipients(
      [
        lead({ email: "a@x.com", host: "one.com" }),
        lead({ email: "A@X.com", host: "two.com" }),
        lead({ email: "b@x.com" }),
      ],
      "all",
    );
    expect(send.map((r) => r.email)).toEqual(["a@x.com", "b@x.com"]);
    // First occurrence wins, and callers order newest-first, so the retained
    // row is the most recent report.
    expect(send[0].host).toBe("one.com");
  });

  it("normalizes the address it will send to", () => {
    const { send } = selectRecipients([lead({ email: "  MiXeD@Example.COM " })], "all");
    expect(send[0].email).toBe("mixed@example.com");
  });

  it("reports why each address was dropped", () => {
    const { send, excluded } = selectRecipients(
      [
        lead({ email: "ok@x.com" }),
        lead({ email: "gone@x.com", unsubscribedAt: "2026-01-01" }),
        lead({ email: "me@profullstack.com" }),
        lead({ email: "noreport@x.com", reportToken: null }),
      ],
      "all",
    );
    expect(send).toHaveLength(1);
    expect(excluded).toEqual([
      { email: "gone@x.com", reason: "unsubscribed" },
      { email: "me@profullstack.com", reason: "internal" },
      { email: "noreport@x.com", reason: "no-report" },
    ]);
  });
});

describe("campaignSubject", () => {
  it("leads with the score they already know", () => {
    expect(campaignSubject(lead({ host: "acme.com", score: 54 }))).toBe(
      "acme.com scored 54/100 — want us to fix it?",
    );
  });

  it("falls back when there is no score", () => {
    expect(campaignSubject(lead({ host: "acme.com", score: null }))).toBe(
      "Your CrawlProof scan of acme.com",
    );
  });
});

describe("hireUrlFor", () => {
  it("prefills the form and tags the source", () => {
    const url = new URL(hireUrlFor(lead({ host: "acme.com", email: "p@x.com" }), "https://crawlproof.com/"));
    expect(url.pathname).toBe("/hire");
    expect(url.searchParams.get("website")).toBe("https://acme.com");
    expect(url.searchParams.get("email")).toBe("p@x.com");
    expect(url.searchParams.get("utm_source")).toBe("lead-campaign");
  });
});
