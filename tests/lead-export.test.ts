import { describe, it, expect } from "vitest";
import { hostOf, pushToOutreachGraph, selectExports, type ScanLead } from "@/lib/leadExport";

const lead = (over: Partial<ScanLead> = {}): ScanLead => ({
  email: "Ann@Acme.com",
  targetUrl: "https://www.acme.com/pricing",
  unsubscribedAt: null,
  consentedAt: null,
  ...over,
});

describe("hostOf", () => {
  it("reduces a scan URL to its host", () => {
    expect(hostOf("https://www.Acme.com/pricing")).toBe("acme.com");
    expect(hostOf("acme.com")).toBe("acme.com");
    expect(hostOf(null)).toBeNull();
    expect(hostOf("localhost")).toBeNull();
  });
});

describe("selectExports", () => {
  it("exports a lead once, lowercased, with the newest scanned site", () => {
    const rows = selectExports(
      [lead(), lead({ email: "ann@acme.com", targetUrl: "https://old.example.org" })],
      new Set(),
    );
    expect(rows).toEqual([{ email: "ann@acme.com", companyDomain: "acme.com", consentBasis: "report_request" }]);
  });

  it("never exports an unsubscribed, internal, role or already-sent address", () => {
    const rows = selectExports(
      [
        lead({ email: "gone@x.io", unsubscribedAt: "2026-01-01" }),
        lead({ email: "me@profullstack.com" }),
        lead({ email: "admin@acme.com" }),
        lead({ email: "not-an-email" }),
        lead({ email: "done@acme.com" }),
      ],
      new Set(["done@acme.com"]),
    );
    expect(rows).toEqual([]);
  });

  it("keeps the person but drops a site they cannot own", () => {
    const [row] = selectExports([lead({ targetUrl: "https://x.com/someone" })], new Set());
    expect(row).toEqual({ email: "ann@acme.com", consentBasis: "report_request" });
  });

  it("marks marketing opt-ins as opt_in", () => {
    const [row] = selectExports([lead({ consentedAt: "2026-10-01" })], new Set());
    expect(row.consentBasis).toBe("opt_in");
  });
});

describe("pushToOutreachGraph", () => {
  it("starts one import per basis, sends rows, finishes with enrichment", async () => {
    const calls: Array<{ url: string; body: any; auth: string | null }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("authorization"),
      });
      const body = url.endsWith("/contacts/imports") ? { importId: `imp_${calls.length}` } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await pushToOutreachGraph(
      [
        { email: "a@acme.com", companyDomain: "acme.com", consentBasis: "opt_in" },
        { email: "b@beta.io", consentBasis: "report_request" },
      ],
      { apiUrl: "https://og.test/api/v1/", apiKey: "og_live_x", fetch: fakeFetch },
    );

    expect(out.map((o) => [o.basis, o.emails])).toEqual([
      ["opt_in", ["a@acme.com"]],
      ["report_request", ["b@beta.io"]],
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://og.test/api/v1/contacts/imports",
      "https://og.test/api/v1/contacts/imports/imp_1/rows",
      "https://og.test/api/v1/contacts/imports/imp_1/finish",
      "https://og.test/api/v1/contacts/imports",
      "https://og.test/api/v1/contacts/imports/imp_4/rows",
      "https://og.test/api/v1/contacts/imports/imp_4/finish",
    ]);
    expect(calls[0].auth).toBe("Bearer og_live_x");
    expect(calls[0].body.consentBasis).toBe("opt_in");
    expect(calls[1].body.rows).toEqual([{ email: "a@acme.com", companyDomain: "acme.com" }]);
    expect(calls[2].body).toEqual({ enrich: true });
  });

  it("throws on an error answer so nothing is recorded as exported", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(
      pushToOutreachGraph([{ email: "a@acme.com", consentBasis: "opt_in" }], {
        apiUrl: "https://og.test/api/v1",
        apiKey: "bad",
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/401/);
  });
});
