import { describe, it, expect } from "vitest";
import { markdownToEmailHtml, markdownToPlainText } from "@/lib/emailMarkdown";
import { isSendableEmail, sendableEmails } from "@/lib/emailRecipients";
import { broadcastEmailHtml } from "@/lib/email";

describe("markdownToEmailHtml", () => {
  it("returns an empty string for empty input", () => {
    expect(markdownToEmailHtml("")).toBe("");
    expect(markdownToEmailHtml("   \n  ")).toBe("");
  });

  it("renders plain text paragraphs with line breaks preserved", () => {
    const html = markdownToEmailHtml(
      "Hello there.\nSecond line.\n\nNext para.",
    );
    expect(html).toContain("Hello there.<br />Second line.");
    expect(html.match(/<p /g)).toHaveLength(2);
  });

  it("renders headings, emphasis, code and lists", () => {
    const html = markdownToEmailHtml(
      "# Title\n\n**bold** *italic* `code()`\n\n- one\n- two\n\n1. first",
    );
    expect(html).toContain("<h1 style=");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain(">code()</code>");
    expect(html).toContain("<ul style=");
    expect(html).toContain("<ol style=");
  });

  it("renders links and autolinks bare URLs", () => {
    const html = markdownToEmailHtml(
      "See [CrawlProof](https://crawlproof.com) or https://crawlproof.com/pricing",
    );
    expect(html).toContain('<a href="https://crawlproof.com" style=');
    expect(html).toContain('<a href="https://crawlproof.com/pricing"');
  });

  it("escapes pasted HTML instead of rendering it", () => {
    const html = markdownToEmailHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops javascript: URLs", () => {
    const html = markdownToEmailHtml("[click](javascript:alert(1))");
    expect(html).not.toContain('href="javascript');
  });

  it("uses colours that read on the dark email shell", () => {
    const html = markdownToEmailHtml("# Title\n\nBody text");
    expect(html).toContain("#e7e9ee"); // heading
    expect(html).toContain("#c3cad6"); // body copy
  });
});

describe("markdownToPlainText", () => {
  it("strips syntax but keeps the text readable", () => {
    const text = markdownToPlainText(
      "# Title\n\n**Bold** and [a link](https://crawlproof.com)",
    );
    expect(text).toContain("Title");
    expect(text).toContain("Bold and a link (https://crawlproof.com)");
    expect(text).not.toContain("**");
  });
});

describe("broadcastEmailHtml", () => {
  it("wraps the rendered body in the CrawlProof shell", () => {
    const html = broadcastEmailHtml({
      subject: "Product update",
      bodyHtml: markdownToEmailHtml("Hello **there**"),
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("CrawlProof");
    expect(html).toContain("Product update");
    expect(html).toContain("<strong>there</strong>");
  });

  it("escapes the subject", () => {
    const html = broadcastEmailHtml({
      subject: '<img src=x onerror="alert(1)">',
      bodyHtml: "<p>hi</p>",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});

describe("isSendableEmail", () => {
  it("accepts ordinary addresses", () => {
    expect(isSendableEmail("anthony@profullstack.com")).toBe(true);
  });

  it("rejects the reserved domains Resend 422s on", () => {
    expect(isSendableEmail("user@example.com")).toBe(false);
    expect(isSendableEmail("user@test.com")).toBe(false);
    expect(isSendableEmail("user@box.local")).toBe(false);
  });

  it("rejects malformed addresses", () => {
    expect(isSendableEmail(null)).toBe(false);
    expect(isSendableEmail("nope")).toBe(false);
    expect(isSendableEmail("user@localhost")).toBe(false);
  });
});

describe("sendableEmails", () => {
  it("normalises, de-duplicates and filters", () => {
    expect(
      sendableEmails([
        "A@Crawlproof.com",
        "a@crawlproof.com",
        "seed@example.com",
        null,
        "broken",
      ]),
    ).toEqual(["a@crawlproof.com"]);
  });
});
