import { describe, it, expect } from "vitest";
import {
  deriveOutreachStatus,
  OUTREACH_STALE_MS,
  type OutreachSocialPost,
} from "@/lib/sp/outreachStatus";

const NOW = Date.parse("2026-06-24T18:30:00Z");
const post = (over: Partial<OutreachSocialPost> = {}): OutreachSocialPost => ({
  status: "queued_browser",
  platform_post_url: null,
  last_error: null,
  ...over,
});

describe("deriveOutreachStatus", () => {
  it("keeps terminal OAuth 'sent' rows authoritative", () => {
    const out = deriveOutreachStatus("sent", null, "2026-06-24T18:17:16Z", null, NOW);
    expect(out).toEqual({ status: "sent", error: null });
  });

  it("keeps terminal OAuth 'failed' rows with their error", () => {
    const out = deriveOutreachStatus("failed", "bad token", "2026-06-24T18:17:16Z", null, NOW);
    expect(out).toEqual({ status: "failed", error: "bad token" });
  });

  it("leaves a manual queued row (no linked post) queued", () => {
    const out = deriveOutreachStatus("queued", null, "2026-06-24T18:17:15Z", null, NOW);
    expect(out).toEqual({ status: "queued", error: null });
  });

  it("promotes a queued row to sent once the worker publishes the post", () => {
    const out = deriveOutreachStatus(
      "queued",
      null,
      "2026-06-24T18:17:15Z",
      post({ status: "published", platform_post_url: "https://x.com/p/1" }),
      NOW,
    );
    expect(out).toEqual({ status: "sent", error: null });
  });

  it("marks a queued row failed with the worker's last_error", () => {
    const out = deriveOutreachStatus(
      "queued",
      null,
      "2026-06-24T18:17:15Z",
      post({ status: "failed", last_error: "cookie expired" }),
      NOW,
    );
    expect(out).toEqual({ status: "failed", error: "cookie expired" });
  });

  it("treats a cancelled post as failed", () => {
    const out = deriveOutreachStatus(
      "queued",
      null,
      "2026-06-24T18:17:15Z",
      post({ status: "cancelled" }),
      NOW,
    );
    expect(out.status).toBe("failed");
  });

  it("keeps a recently-queued browser post as queued", () => {
    const createdAt = new Date(NOW - 60_000).toISOString(); // 1 min ago
    const out = deriveOutreachStatus("queued", null, createdAt, post(), NOW);
    expect(out.status).toBe("queued");
  });

  it("expires a stale queued browser post to timed_out", () => {
    const createdAt = new Date(NOW - OUTREACH_STALE_MS - 1).toISOString();
    const out = deriveOutreachStatus("queued", null, createdAt, post(), NOW);
    expect(out.status).toBe("timed_out");
    expect(out.error).toMatch(/never reported back/);
  });

  it("still resolves a stale post if the worker did finish (published wins over expiry)", () => {
    const createdAt = new Date(NOW - OUTREACH_STALE_MS - 1).toISOString();
    const out = deriveOutreachStatus(
      "queued",
      null,
      createdAt,
      post({ status: "published" }),
      NOW,
    );
    expect(out.status).toBe("sent");
  });
});
