import { describe, expect, test } from "vitest";
import { spokenDomain, spokenLabel, spokenText } from "../lib/ads/video/spoken";
import { narrationVariants } from "../lib/ads/video/narration";

describe("spoken domains and names", () => {
  test("our domains are read the way we say them", () => {
    expect(spokenDomain("logicsrc.com")).toBe("logic source dot com");
    expect(spokenDomain("openmcp.logicsrc.com")).toBe("open m c p dot logic source dot com");
    expect(spokenDomain("https://www.pwamart.com/x")).toBe("p w a mart dot com");
    expect(spokenDomain("p0dcasters.com")).toBe("podcasters dot com");
    expect(spokenDomain("readm3.com")).toBe("read me dot com");
    expect(spokenDomain("nichedb.dev")).toBe("niche d b dot dev");
    expect(spokenDomain("pit.world")).toBe("pit dot world");
    expect(spokenDomain("moshcode.sh")).toBe("mosh code dot S H");
    expect(spokenDomain("brisk.news")).toBe("brisk dot news");
  });

  test("names nobody listed still come out readable", () => {
    expect(spokenLabel("mysrc")).toBe("mysrc");
    expect(spokenLabel("codesrc")).toBe("code source");
    expect(spokenLabel("h4ck3r")).toBe("hacker");
    expect(spokenLabel("my-ai-app")).toBe("my A I app");
    expect(spokenDomain("example.io")).toBe("example dot I O");
    expect(spokenLabel("2600")).toBe("2600");
  });

  test("copy keeps its words and punctuation, and our names in it are said right", () => {
    expect(spokenText("Relays · LogicSRC OpenMCP catalog")).toBe("Relays · Logic Source Open M C P catalog");
    expect(spokenText("Try the CLI at logicsrc.com/install.")).toBe("Try the C L I at logic source dot com.");
    expect(spokenText("Visit site")).toBe("Visit site");
  });

  test("the narration speaks the domain, not the spelling", () => {
    const variants = narrationVariants({ headline: "MCP relays you can reach", ctaText: "Browse the catalog", domain: "openmcp.logicsrc.com" } as never);
    expect(variants[0]).toBe("M C P relays you can reach. Browse the catalog at open m c p dot logic source dot com.");
    expect(variants.every((one) => !/logicsrc/i.test(one))).toBe(true);
  });
});
