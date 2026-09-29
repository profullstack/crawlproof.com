import { describe, it, expect } from "vitest";
import { isSenderFailure } from "@/lib/outreach/pipeline";

// A sender failure halts the campaign tick, so misreading one recipient's
// bounce as a dead sender would stop a healthy campaign, and missing a dead
// sender pays for a fresh draft to every prospect in the queue.
describe("isSenderFailure", () => {
  it("treats rejected SMTP credentials as the sender's failure", () => {
    // Verbatim from forwardemail.net, the failure that ran from 2026-09-25.
    expect(
      isSenderFailure(
        'Invalid login: 535 5.7.8 Invalid username or password, please try again or go to https://forwardemail.net/my-account/domains/profullstack.com/aliases and click "Generate Password"',
      ),
    ).toBe(true);
  });

  it("treats an unreachable relay as the sender's failure", () => {
    expect(isSenderFailure("connect ECONNREFUSED 127.0.0.1:465")).toBe(true);
    expect(isSenderFailure("getaddrinfo ENOTFOUND smtp.example.com")).toBe(true);
    expect(isSenderFailure("RESEND_API_KEY not set")).toBe(true);
  });

  it("does not halt on one recipient's rejection", () => {
    expect(isSenderFailure("550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown")).toBe(false);
    expect(isSenderFailure("552 5.2.2 Mailbox full")).toBe(false);
    expect(isSenderFailure("send failed")).toBe(false);
  });
});
