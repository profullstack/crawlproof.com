import { afterEach, describe, it, expect } from "vitest";
import {
  pickDefaultSubreddit,
  resolveSubreddit,
} from "@/lib/sp/redditSubreddit";

const ENV = "SP_REDDIT_DEFAULT_SUBS";

afterEach(() => {
  delete process.env[ENV];
});

describe("resolveSubreddit", () => {
  it("keeps a supplied subreddit and strips a leading r/", () => {
    expect(resolveSubreddit("r/webdev", "anything")).toBe("webdev");
    expect(resolveSubreddit("/r/SEO", "anything")).toBe("SEO");
    expect(resolveSubreddit("SideProject", "")).toBe("SideProject");
  });

  it("falls back to a content-routed subreddit when none supplied", () => {
    expect(resolveSubreddit("", "How I improved my Google search ranking"))
      .toBe("SEO");
    expect(resolveSubreddit(null, "")).toBe("SideProject"); // default first entry
  });
});

describe("pickDefaultSubreddit", () => {
  it("routes by topical keywords", () => {
    expect(pickDefaultSubreddit("Cut my backlink audit crawl time")).toBe("SEO");
    expect(pickDefaultSubreddit("We just built and launched a new SaaS tool")).toBe(
      "SideProject",
    );
    expect(pickDefaultSubreddit("Using an LLM / ChatGPT for answer-engine AEO")).toBe(
      "artificial",
    );
    expect(pickDefaultSubreddit("Grew my blog traffic on a niche affiliate site")).toBe(
      "juststart",
    );
  });

  it("defaults to the first curated entry when nothing matches", () => {
    expect(pickDefaultSubreddit("completely unrelated text")).toBe("SideProject");
    expect(pickDefaultSubreddit("")).toBe("SideProject");
  });

  it("honors the SP_REDDIT_DEFAULT_SUBS override (most-preferred first)", () => {
    process.env[ENV] = "r/test, myovveride";
    expect(pickDefaultSubreddit("How I improved my Google ranking")).toBe("test");
    expect(resolveSubreddit("", "seo ranking backlink")).toBe("test");
  });
});
