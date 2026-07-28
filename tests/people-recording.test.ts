import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const upserts: unknown[] = [];
vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from: () => {
      // Tracks whether this chain has reached an insert, so the terminal
      // maybeSingle can answer "no existing row" on a lookup and "here is the
      // new id" on a write — which is what upsertContact distinguishes.
      let inserted = false;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: inserted ? { id: "contact-1" } : null }),
        insert: (row: unknown) => {
          upserts.push(row);
          inserted = true;
          return chain;
        },
        update: () => chain,
      };
      return chain;
    },
  }),
}));

const { recordDiscoveredPeople } = await import("@/lib/outreach/contacts");

beforeEach(() => {
  upserts.length = 0;
});

const cto = {
  fullName: "Jane Doe",
  jobTitle: "CTO",
  company: "Acme",
  linkedinUrl: "https://linkedin.com/in/janedoe",
  location: "Austin",
  sourceUrl: "https://ctodirectory.test/jane",
};

describe("recordDiscoveredPeople", () => {
  it("records a person who has no address yet", async () => {
    // The directory gives a name, a title and a profile and withholds the
    // email. Waiting for an address before recording anything means finding
    // the same human again on every run.
    const n = await recordDiscoveredPeople({ organizationId: "org-1", people: [cto] });
    expect(n).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      full_name: "Jane Doe",
      title: "CTO",
      company_name: "Acme",
      linkedin_url: "https://linkedin.com/in/janedoe",
    });
  });

  it("stamps the campaign's niche onto the people it found", async () => {
    await recordDiscoveredPeople({ organizationId: "org-1", people: [cto], niche: "CTOs" });
    expect(upserts[0]).toMatchObject({ niche: "CTOs" });
  });

  it("does nothing without an organization to scope to", async () => {
    expect(await recordDiscoveredPeople({ organizationId: null, people: [cto] })).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it("does nothing when a run named nobody", async () => {
    expect(await recordDiscoveredPeople({ organizationId: "org-1", people: [] })).toBe(0);
  });

  it("ranks structured markup above scraped text", async () => {
    await recordDiscoveredPeople({
      organizationId: "org-1",
      people: [{ ...cto, source: "json-ld" }],
    });
    expect((upserts[0] as { field_sources: Record<string, string> }).field_sources.full_name).toBe(
      "json-ld",
    );
  });
});

describe("both discovery paths record people", () => {
  // The runner read `prospects` and `errors` off the discovery result and
  // dropped `people` entirely, so every person found by a campaign was
  // discarded after being rendered, paginated and parsed for. The finder did
  // it correctly, which is precisely why nobody noticed.
  const runner = readFileSync(new URL("../lib/outreach/runner.ts", import.meta.url), "utf8");
  const action = readFileSync(new URL("../app/actions/leads.ts", import.meta.url), "utf8");

  it("the campaign runner records the people it names", () => {
    expect(runner).toContain("recordDiscoveredPeople");
    expect(runner).toContain("found.people");
  });

  it("the one-shot finder records them too", () => {
    expect(action).toContain("recordDiscoveredPeople");
  });

  it("both go through the one shared recorder", () => {
    // Two copies is what let them drift the first time.
    expect(runner).not.toMatch(/upsertContact\(/);
    expect(action).not.toMatch(/upsertContact\(/);
  });
});
