import { afterEach, describe, expect, it, vi } from "vitest";
import { callAlert, phoneAlertText } from "../lib/uptime";

describe("uptime phone alerts", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("says which monitor and which way it went", () => {
    expect(phoneAlertText({ name: "ugig.net" }, "down", "unexpected status 502")).toBe(
      "CrawlProof uptime: ugig.net is DOWN. unexpected status 502",
    );
    expect(phoneAlertText({ name: "ugig.net" }, "up", "")).toBe("CrawlProof uptime: ugig.net is back UP.");
  });

  it("posts a critical alert to smshub for the monitor's phone", async () => {
    vi.stubEnv("SMSHUB_ALERT_API_KEY", "smshub_test");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await callAlert({ name: "ugig.net", alert_phone: "+14155550123" }, "up", "It was down for 4m.", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://smshub.dev/api/v1/alerts");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer smshub_test");
    expect(JSON.parse(init.body as string)).toEqual({
      to: "+14155550123",
      message: "CrawlProof uptime: ugig.net is back UP. It was down for 4m.",
      severity: "critical",
    });
  });

  it("does nothing without a phone or a key", async () => {
    const fetchImpl = vi.fn();
    vi.stubEnv("SMSHUB_ALERT_API_KEY", "smshub_test");
    await callAlert({ name: "a", alert_phone: null }, "down", "x", fetchImpl);
    vi.stubEnv("SMSHUB_ALERT_API_KEY", "");
    await callAlert({ name: "a", alert_phone: "+14155550123" }, "down", "x", fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws when smshub fails", async () => {
    vi.stubEnv("SMSHUB_ALERT_API_KEY", "smshub_test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(callAlert({ name: "a", alert_phone: "+14155550123" }, "down", "x", fetchImpl)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
