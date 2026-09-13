import { describe, expect, it } from "vitest";
import {
  codeFromProfile,
  commissionCents,
  isAffiliateCode,
  isPayAddress,
  isVerifiedOrigin,
  linkFor,
  parseDescriptor,
  parseJoinRequest,
  readProfile,
  walletOf,
} from "@/lib/affiliate/spec";
import { ourDescriptorJson } from "@/lib/affiliate/program";

const FULL = {
  merchant: { name: "Northwind", web: "https://northwind.example", currency: "usd", terms: "https://northwind.example/terms", region: "EU" },
  updated: "2026-09-13T06:00:00Z",
  programs: [
    {
      id: "partners",
      title: "Partners",
      join: "https://northwind.example/join",
      ledger: "https://northwind.example/ledger",
      approval: "open",
      pays: [
        { event: "sale", kind: "percent", value: 30 },
        { event: "subscription", kind: "percent", value: 30, months: 12 },
        { event: "signup", kind: "amount", value: 0.5 },
        { event: "view", kind: "amount", value: 1 },
      ],
      link: { param: "ref", deep: true, aliases: ["oa"] },
      window: 30,
      attribution: "first",
      hold_days: 14,
      payout: { methods: ["usdc/eip155:137"], min: 10, schedule: "weekly" },
      self: "allowed",
      status: "active",
      tier: "gold",
    },
  ],
};

describe("parseDescriptor", () => {
  it("reads the full example and keeps unknown keys", () => {
    const out = parseDescriptor(FULL);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const p = out.descriptor.programs[0];
    expect(out.descriptor.merchant.currency).toBe("USD");
    expect(out.descriptor.merchant.extra).toEqual({ region: "EU" });
    expect(p.id).toBe("partners");
    expect(p.pays).toHaveLength(3);
    expect(p.link).toEqual({ param: "ref", template: undefined, deep: true, aliases: ["oa"] });
    expect(p.attribution).toBe("first");
    expect(p.self).toBe("allowed");
    expect(p.payout).toEqual({ methods: ["usdc/eip155:137"], min: 10, schedule: "weekly" });
    expect(p.extra).toEqual({ tier: "gold" });
    expect(out.warnings.join(" ")).toContain("view");
  });

  it("accepts the smallest valid descriptor with defaults", () => {
    const out = parseDescriptor({ merchant: { name: "N" }, programs: [{ title: "Partners", pays: [{ event: "sale", kind: "percent", value: 10 }] }] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const p = out.descriptor.programs[0];
    expect(p.id).toBe("partners");
    expect(p.approval).toBe("review");
    expect(p.attribution).toBe("last");
    expect(p.self).toBe("refused");
    expect(p.status).toBe("active");
    expect(p.link.param).toBe("oa");
    expect(p.window).toBeUndefined();
  });

  it("refuses what cannot pay", () => {
    expect(parseDescriptor(null)).toMatchObject({ ok: false });
    expect(parseDescriptor({ merchant: {}, programs: [] })).toMatchObject({ ok: false, error: expect.stringContaining("merchant.name") });
    expect(parseDescriptor({ merchant: { name: "N" }, programs: [] })).toMatchObject({ ok: false, error: expect.stringContaining("no programs") });
    expect(parseDescriptor({ merchant: { name: "N" }, programs: [{ title: "T", pays: [{ event: "sale", kind: "percent", value: 250 }] }] })).toMatchObject({ ok: false });
  });

  it("drops a duplicate program id", () => {
    const out = parseDescriptor({
      merchant: { name: "N" },
      programs: [
        { id: "a", title: "A", pays: [{ event: "sale", kind: "amount", value: 1 }] },
        { id: "a", title: "A again", pays: [{ event: "sale", kind: "amount", value: 2 }] },
      ],
    });
    expect(out.ok && out.descriptor.programs).toHaveLength(1);
  });

  it("our own descriptor parses as verified and pays a sale", () => {
    const out = parseDescriptor(ourDescriptorJson("https://crawlproof.com", "2026-09-13T00:00:00Z"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.warnings).toEqual([]);
    const p = out.descriptor.programs[0];
    expect(p.join).toBe("https://crawlproof.com/api/affiliate/v1/join");
    expect(p.approval).toBe("open");
    expect(commissionCents(p.pays, "sale", 4900)).toBe(1470);
    expect(isVerifiedOrigin("https://crawlproof.com/.well-known/openaffiliate.json", out.descriptor.merchant.web)).toBe(true);
  });
});

describe("commissionCents", () => {
  const pays = parseDescriptor(FULL);
  const p = pays.ok ? pays.descriptor.programs[0].pays : [];
  it("percent of the amount, rounded to a cent", () => {
    expect(commissionCents(p, "sale", 4900)).toBe(1470);
    expect(commissionCents(p, "sale", 1)).toBe(0);
    expect(commissionCents(p, "sale", 333)).toBe(100);
  });
  it("flat amounts and unpaid events", () => {
    expect(commissionCents(p, "signup", 0)).toBe(50);
    expect(commissionCents(p, "lead", 10000)).toBe(0);
  });
  it("subscription renewals stop paying after months", () => {
    expect(commissionCents(p, "subscription", 1000, 1)).toBe(300);
    expect(commissionCents(p, "subscription", 1000, 12)).toBe(300);
    expect(commissionCents(p, "subscription", 1000, 13)).toBe(0);
  });
});

describe("linkFor", () => {
  const program = { link: { param: "oa", deep: true, aliases: [] as string[] }, url: "https://m.example/partners" };
  it("deep-links when allowed, else web with the param", () => {
    expect(linkFor(program, "anthony", "https://m.example", "https://m.example/pricing?x=1")).toBe("https://m.example/pricing?x=1&oa=anthony");
    expect(linkFor(program, "anthony", "https://m.example")).toBe("https://m.example/?oa=anthony");
    expect(linkFor({ ...program, link: { ...program.link, deep: false } }, "a", "https://m.example", "https://m.example/p")).toBe("https://m.example/?oa=a");
  });
  it("uses the template when given", () => {
    expect(linkFor({ link: { param: "oa", template: "https://m.example/go/{code}", deep: false, aliases: [] } }, "a b")).toBe("https://m.example/go/a%20b");
  });
  it("returns null with nothing to link to", () => {
    expect(linkFor({ link: { param: "oa", deep: false, aliases: [] } }, "a")).toBeNull();
  });
});

describe("join request", () => {
  it("needs a profile URL and validates the rest", () => {
    expect(parseJoinRequest({})).toMatchObject({ ok: false, error: expect.stringContaining("profile") });
    expect(parseJoinRequest({ profile: "ftp://x" })).toMatchObject({ ok: false });
    expect(parseJoinRequest({ profile: "https://a.example/.well-known/openprofile.md", pay: "nope" })).toMatchObject({ ok: false, error: expect.stringContaining("pay") });
    expect(parseJoinRequest({ profile: "https://a.example/p.md", webhook: "http://insecure" })).toMatchObject({ ok: false, error: expect.stringContaining("webhook") });
    expect(parseJoinRequest({ profile: "https://a.example/p.md", code: "Bad Code" })).toMatchObject({ ok: false, error: expect.stringContaining("code") });
    expect(
      parseJoinRequest({ profile: "https://a.example/p.md", pay: "eip155:137:0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5", webhook: "https://a.example/hook", code: "anthony", program: "partners" }),
    ).toEqual({
      ok: true,
      request: { profile: "https://a.example/p.md", pay: "eip155:137:0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5", webhook: "https://a.example/hook", code: "anthony", program: "partners" },
    });
  });
  it("codes and pay addresses", () => {
    expect(isAffiliateCode("abc")).toBe(true);
    expect(isAffiliateCode("a-b-c-1")).toBe(true);
    expect(isAffiliateCode("ab")).toBe(false);
    expect(isAffiliateCode("-abc")).toBe(false);
    expect(isAffiliateCode("ABC")).toBe(false);
    expect(isPayAddress("0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5")).toBe(true);
    expect(isPayAddress("eip155:8453:0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5")).toBe(true);
    expect(isPayAddress("0x123")).toBe(false);
    expect(walletOf("eip155:137:0xabc")).toBe("0xabc");
  });
});

describe("readProfile", () => {
  const md = `# Anthony Ettinger

Kind: person
Handle: @chovy
Email: <anthony@profullstack.com>
Pay: eip155:137:0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5

Builds things.

## Accounts

- https://github.com/chovy
- https://crawlproof.com/?oa=chovy

## Operator

- Name: Profullstack
- Profile: https://profullstack.com/.well-known/openprofile.md
`;
  it("reads the identity block and accounts", () => {
    const f = readProfile(md);
    expect(f.name).toBe("Anthony Ettinger");
    expect(f.kind).toBe("person");
    expect(f.handle).toBe("chovy");
    expect(f.email).toBe("anthony@profullstack.com");
    expect(f.pay).toBe("eip155:137:0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5");
    expect(f.accounts).toEqual(["https://github.com/chovy", "https://crawlproof.com/?oa=chovy"]);
    expect(f.operator).toBe("https://profullstack.com/.well-known/openprofile.md");
  });
  it("suggests a code from the handle, the name, then the host", () => {
    expect(codeFromProfile("https://x.example/p.md", readProfile(md))).toBe("chovy");
    expect(codeFromProfile("https://x.example/p.md", { name: "Jane Q. Public" })).toBe("jane-q-public");
    expect(codeFromProfile("https://nichedb.dev/.well-known/openprofile.md")).toBe("nichedb");
    expect(codeFromProfile("not a url")).toBe("partner");
  });
});
