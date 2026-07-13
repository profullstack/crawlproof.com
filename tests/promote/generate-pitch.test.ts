import { describe, it, expect } from "vitest";
import { parseLinks, cadenceLabel, CADENCE_PRESETS } from "@/lib/promote/generatePitch";

describe("parseLinks", () => {
  it("extracts valid URLs from newline-separated input", () => {
    const input = `https://example.com/page-1
https://example.com/page-2
https://example.com/page-3`;
    expect(parseLinks(input)).toEqual([
      "https://example.com/page-1",
      "https://example.com/page-2",
      "https://example.com/page-3",
    ]);
  });

  it("handles comma-separated input", () => {
    const input = "https://a.com, https://b.com, https://c.com";
    expect(parseLinks(input)).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
  });

  it("handles space-separated input", () => {
    const input = "https://a.com https://b.com";
    expect(parseLinks(input)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("deduplicates URLs", () => {
    const input = `https://a.com
https://a.com
https://b.com
https://a.com`;
    expect(parseLinks(input)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("filters out invalid URLs", () => {
    const input = `https://good.com
not-a-url
ftp://not-http.com
https://also-good.com
just text`;
    expect(parseLinks(input)).toEqual([
      "https://good.com",
      "https://also-good.com",
    ]);
  });

  it("handles empty input", () => {
    expect(parseLinks("")).toEqual([]);
    expect(parseLinks("   \n\n  ")).toEqual([]);
  });

  it("handles http:// URLs", () => {
    const input = "http://example.com";
    expect(parseLinks(input)).toEqual(["http://example.com"]);
  });

  it("handles mixed separators", () => {
    const input = "https://a.com,https://b.com\nhttps://c.com https://d.com";
    const result = parseLinks(input);
    expect(result).toContain("https://a.com");
    expect(result).toContain("https://b.com");
    expect(result).toContain("https://c.com");
    expect(result).toContain("https://d.com");
    expect(result.length).toBe(4);
  });
});

describe("cadenceLabel", () => {
  it("returns preset labels for known cadence values", () => {
    expect(cadenceLabel(900)).toBe("Every 15 min");
    expect(cadenceLabel(1800)).toBe("Every 30 min");
    expect(cadenceLabel(3600)).toBe("Every hour");
    expect(cadenceLabel(10800)).toBe("Every 3 hours");
    expect(cadenceLabel(21600)).toBe("Every 6 hours");
    expect(cadenceLabel(86400)).toBe("Daily");
  });

  it("generates labels for custom minute-based cadences", () => {
    expect(cadenceLabel(600)).toBe("Every 10 min");
    expect(cadenceLabel(2700)).toBe("Every 45 min");
  });

  it("generates labels for custom hour-based cadences", () => {
    expect(cadenceLabel(7200)).toBe("Every 2 hours");
    expect(cadenceLabel(43200)).toBe("Every 12 hours");
  });

  it("generates labels for custom day-based cadences", () => {
    expect(cadenceLabel(172800)).toBe("Every 2 days");
  });
});

describe("CADENCE_PRESETS", () => {
  it("has 6 presets with valid seconds values", () => {
    expect(CADENCE_PRESETS.length).toBe(6);
    for (const preset of CADENCE_PRESETS) {
      expect(preset.seconds).toBeGreaterThanOrEqual(300);
      expect(preset.seconds).toBeLessThanOrEqual(604800);
      expect(preset.label).toBeTruthy();
    }
  });

  it("is sorted by ascending seconds", () => {
    for (let i = 1; i < CADENCE_PRESETS.length; i++) {
      expect(CADENCE_PRESETS[i].seconds).toBeGreaterThan(
        CADENCE_PRESETS[i - 1].seconds,
      );
    }
  });
});
