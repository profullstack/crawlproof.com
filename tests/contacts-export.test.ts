import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { csvField, toCsv, EXPORT_COLUMNS } from "@/lib/outreach/contactsExport";

const empty = Object.fromEntries(EXPORT_COLUMNS.map((c) => [c, null])) as Parameters<
  typeof toCsv
>[0][number];

describe("csvField", () => {
  it("leaves ordinary text alone", () => {
    expect(csvField("Acme Ltd")).toBe("Acme Ltd");
  });

  it("quotes a field containing the delimiter", () => {
    expect(csvField("Acme, Ltd")).toBe('"Acme, Ltd"');
  });

  it("doubles inner quotes", () => {
    expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
  });

  it("defuses a spreadsheet formula", () => {
    // A contact list is exactly the kind of file somebody opens in Excel
    // without thinking, and a leading = there is executable.
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("+44 7700 900000")).toBe("'+44 7700 900000");
    expect(csvField("-5")).toBe("'-5");
    expect(csvField("@handle")).toBe("'@handle");
  });

  it("writes nothing for a missing value", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("leads with a header row", () => {
    expect(toCsv([]).split("\r\n")[0]).toBe(EXPORT_COLUMNS.join(","));
  });

  it("still produces a usable file with no contacts", () => {
    // A header-only CSV opens; an empty file looks like a failed download.
    expect(toCsv([])).toBe(`${EXPORT_COLUMNS.join(",")}\r\n`);
  });

  it("writes one line per contact, in column order", () => {
    const csv = toCsv([{ ...empty, email: "a@b.test", company_name: "Acme", niche: "designers" }]);
    const [, row] = csv.trim().split("\r\n");
    const cells = row.split(",");
    expect(cells[EXPORT_COLUMNS.indexOf("email")]).toBe("a@b.test");
    expect(cells[EXPORT_COLUMNS.indexOf("company_name")]).toBe("Acme");
    expect(cells[EXPORT_COLUMNS.indexOf("niche")]).toBe("designers");
  });

  it("keeps a comma in a company name from shifting every later column", () => {
    const csv = toCsv([{ ...empty, company_name: "Acme, Ltd", niche: "designers" }]);
    expect(csv).toContain('"Acme, Ltd"');
    expect(csv.trim().split("\r\n")).toHaveLength(2);
  });

  it("ends with a newline", () => {
    expect(toCsv([{ ...empty, email: "a@b.test" }]).endsWith("\r\n")).toBe(true);
  });
});

describe("both research paths record a contact", () => {
  // The scanning branch never called recordContact, so the shared table held
  // nine rows against seventy-seven addressable leads — every one of them
  // written onto a prospect and nowhere else. A unit test of upsertContact
  // passed throughout, because the bug was a missing call.
  const pipeline = readFileSync(new URL("../lib/outreach/pipeline.ts", import.meta.url), "utf8");

  it("calls recordContact more than once", () => {
    const calls = pipeline.match(/await recordContact\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("links the prospect to the contact on the scanning path", () => {
    expect(pipeline).toContain("contact_id: scannedContactId");
  });

  it("records the niche, without which the list cannot be segmented", () => {
    expect(pipeline).toContain("niche,");
    expect(pipeline).toMatch(/from\("outreach_campaigns"\)[\s\S]{0,120}select\("name"\)/);
  });
});
