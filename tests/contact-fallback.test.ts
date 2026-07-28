import { describe, it, expect, vi, beforeEach } from "vitest";

// The fallback spends SERP calls, so the tests drive a fake search rather
// than the real API — what matters is when it queries, what it asks, and
// whether it trusts what comes back.
const searchSerp = vi.fn();
vi.mock("@/lib/alerts/valueserp", () => ({ searchSerp: (...a: unknown[]) => searchSerp(...a) }));

const { findContactViaSearch } = await import("@/lib/outreach/contactFallback");

const empty = { ok: true, calls: 1, results: [] };

beforeEach(() => {
  searchSerp.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, text: async () => "" })));
});

describe("findContactViaSearch", () => {
  it("scopes the first query to the site itself", async () => {
    searchSerp.mockResolvedValue(empty);
    await findContactViaSearch({ host: "janedoe.design", label: "Jane Doe" });
    expect(searchSerp.mock.calls[0][0].query).toContain("site:janedoe.design");
  });

  it("pulls an address straight out of a SERP snippet", async () => {
    searchSerp.mockResolvedValueOnce({
      ok: true,
      calls: 1,
      results: [
        {
          position: 1,
          title: "Contact — Jane Doe",
          snippet: "Get in touch at hello@janedoe.design for freelance work",
          url: "https://janedoe.design/contact",
          domain: "janedoe.design",
          date: null,
        },
      ],
    });
    const res = await findContactViaSearch({ host: "janedoe.design", label: "Jane Doe" });
    expect(res.candidates.map((c) => c.email)).toContain("hello@janedoe.design");
  });

  it("stops after the site-scoped query when that already worked", async () => {
    searchSerp.mockResolvedValueOnce({
      ok: true,
      calls: 1,
      results: [
        {
          position: 1,
          title: "Contact",
          snippet: "hello@janedoe.design",
          url: "https://janedoe.design/contact",
          domain: "janedoe.design",
          date: null,
        },
      ],
    });
    const res = await findContactViaSearch({ host: "janedoe.design", label: "Jane Doe" });
    // One call, not two: the open query is a cost only paid when needed.
    expect(searchSerp).toHaveBeenCalledTimes(1);
    expect(res.calls).toBe(1);
  });

  it("falls through to a name query when the site yields nothing", async () => {
    searchSerp.mockResolvedValue(empty);
    await findContactViaSearch({ host: "janedoe.design", label: "Jane Doe" });
    expect(searchSerp).toHaveBeenCalledTimes(2);
    const second = searchSerp.mock.calls[1][0].query;
    expect(second).toContain('"Jane Doe"');
    // Excludes the site we already searched, or it just returns the same pages.
    expect(second).toContain("-site:janedoe.design");
  });

  it("skips the name query when the label is just the hostname", async () => {
    searchSerp.mockResolvedValue(empty);
    await findContactViaSearch({ host: "janedoe.design", label: "janedoe.design" });
    expect(searchSerp).toHaveBeenCalledTimes(1);
  });

  it("skips the name query when there is no label to search", async () => {
    searchSerp.mockResolvedValue(empty);
    await findContactViaSearch({ host: "janedoe.design" });
    expect(searchSerp).toHaveBeenCalledTimes(1);
  });

  it("ranks a same-domain address above one found elsewhere", async () => {
    searchSerp
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({
        ok: true,
        calls: 1,
        results: [
          {
            position: 1,
            title: "Jane on a listing site",
            snippet: "contact jane.doe@somedirectory.test or hi@janedoe.design",
            url: "https://somedirectory.test/jane",
            domain: "somedirectory.test",
            date: null,
          },
        ],
      });
    const res = await findContactViaSearch({ host: "janedoe.design", label: "Jane Doe" });
    expect(res.candidates[0].email).toBe("hi@janedoe.design");
    expect(res.candidates[0].sameDomain).toBe(true);
  });

  it("reports the SERP calls it spent", async () => {
    searchSerp.mockResolvedValue(empty);
    const res = await findContactViaSearch({ host: "janedoe.design", label: "Jane Doe" });
    expect(res.calls).toBe(2);
  });

  it("says plainly when it found nothing", async () => {
    searchSerp.mockResolvedValue(empty);
    const res = await findContactViaSearch({ host: "janedoe.design", label: "Jane Doe" });
    expect(res.candidates).toEqual([]);
    expect(res.note).toMatch(/no contact address/i);
  });

  it("returns nothing for a junk host rather than searching", async () => {
    const res = await findContactViaSearch({ host: "" });
    expect(searchSerp).not.toHaveBeenCalled();
    expect(res.candidates).toEqual([]);
  });
});
