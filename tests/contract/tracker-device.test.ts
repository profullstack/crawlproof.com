import { describe, expect, it } from "vitest";
import { parseDevice } from "@/lib/tracker/device";

describe("parseDevice", () => {
  it("returns empty fields for missing UA", () => {
    expect(parseDevice(null)).toEqual({ deviceType: "", browser: "", os: "" });
    expect(parseDevice("")).toEqual({ deviceType: "", browser: "", os: "" });
  });

  it("classifies desktop Chrome on Windows", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    expect(parseDevice(ua)).toEqual({
      deviceType: "desktop",
      browser: "Chrome",
      os: "Windows",
    });
  });

  it("classifies iPhone Safari as mobile iOS", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    expect(parseDevice(ua)).toEqual({
      deviceType: "mobile",
      browser: "Safari",
      os: "iOS",
    });
  });

  it("classifies iPad as a tablet", () => {
    const ua =
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1";
    expect(parseDevice(ua).deviceType).toBe("tablet");
    expect(parseDevice(ua).os).toBe("iOS");
  });

  it("distinguishes Android phones from tablets", () => {
    const phone =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    const tablet =
      "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    expect(parseDevice(phone)).toMatchObject({
      deviceType: "mobile",
      browser: "Chrome",
      os: "Android",
    });
    expect(parseDevice(tablet).deviceType).toBe("tablet");
  });

  it("detects Edge over Chrome and macOS Safari", () => {
    const edge =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
    expect(parseDevice(edge).browser).toBe("Edge");

    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    expect(parseDevice(mac)).toEqual({
      deviceType: "desktop",
      browser: "Safari",
      os: "macOS",
    });
  });

  it("flags obvious bots as device type bot", () => {
    expect(parseDevice("Mozilla/5.0 (compatible; GPTBot/1.2)").deviceType).toBe(
      "bot",
    );
    expect(parseDevice("curl/8.4.0").deviceType).toBe("bot");
  });
});
