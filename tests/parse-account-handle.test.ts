import { describe, it, expect } from "vitest";
import { parseAccountHandle } from "@/lib/sp/parseHandle";

describe("parseAccountHandle", () => {
  it("leaves a bare handle alone", () => {
    expect(parseAccountHandle("profullstackinc", "x").handle).toBe(
      "profullstackinc",
    );
    expect(parseAccountHandle("  @profullstackinc ", "x").handle).toBe(
      "profullstackinc",
    );
    expect(parseAccountHandle("61556287853382", "facebook_page").handle).toBe(
      "61556287853382",
    );
  });

  it("takes the username out of an x/twitter URL", () => {
    for (const input of [
      "https://x.com/profullstackinc",
      "https://x.com/profullstackinc/",
      "x.com/profullstackinc",
      "https://www.twitter.com/profullstackinc",
      "https://mobile.x.com/profullstackinc",
      "https://x.com/profullstackinc/status/1234567890",
      "https://x.com/profullstackinc?ref=foo",
    ]) {
      expect(parseAccountHandle(input, "x").handle, input).toBe(
        "profullstackinc",
      );
    }
  });

  it("takes the page id out of every Facebook URL shape", () => {
    const cases: Array<[string, string]> = [
      [
        "https://www.facebook.com/profile.php?id=61556287853382",
        "61556287853382",
      ],
      ["https://m.facebook.com/profile.php?id=61556287853382", "61556287853382"],
      ["https://www.facebook.com/pages/My-Page/123456789", "123456789"],
      [
        "https://www.facebook.com/pages/category/Software/My-Page/123456789",
        "123456789",
      ],
      ["https://www.facebook.com/people/Some-Name/61556287853382", "61556287853382"],
      ["https://www.facebook.com/MyPage", "MyPage"],
      ["https://www.facebook.com/MyPage/about", "MyPage"],
      ["facebook.com/MyPage", "MyPage"],
      ["https://www.facebook.com/groups/123456789", "123456789"],
    ];
    for (const [input, expected] of cases) {
      expect(parseAccountHandle(input, "facebook_page").handle, input).toBe(
        expected,
      );
    }
  });

  it("handles the two Facebook rows that got created as separate accounts", () => {
    // The real duplicate from prod: these must now collapse to one id.
    const url = parseAccountHandle(
      "https://www.facebook.com/profile.php?id=61556287853382",
      "facebook_page",
    ).handle;
    const bare = parseAccountHandle("61556287853382", "facebook_page").handle;
    expect(url).toBe(bare);
  });

  it("takes the vanity name out of a LinkedIn URL", () => {
    expect(
      parseAccountHandle(
        "https://www.linkedin.com/in/anthonyettinger/",
        "linkedin",
      ).handle,
    ).toBe("anthonyettinger");
    expect(
      parseAccountHandle(
        "https://www.linkedin.com/company/profullstack/",
        "linkedin",
      ).handle,
    ).toBe("profullstack");
    expect(
      parseAccountHandle(
        "https://www.linkedin.com/in/anthonyettinger/recent-activity/all/",
        "linkedin",
      ).handle,
    ).toBe("anthonyettinger");
  });

  it("takes the username out of reddit, instagram and threads URLs", () => {
    expect(
      parseAccountHandle("https://www.reddit.com/user/Minimum_Hour519", "reddit")
        .handle,
    ).toBe("Minimum_Hour519");
    expect(
      parseAccountHandle("https://reddit.com/u/Minimum_Hour519/", "reddit")
        .handle,
    ).toBe("Minimum_Hour519");
    expect(
      parseAccountHandle("https://www.instagram.com/profullstack/", "instagram")
        .handle,
    ).toBe("profullstack");
    expect(
      parseAccountHandle("https://www.threads.net/@profullstack", "threads")
        .handle,
    ).toBe("profullstack");
    expect(
      parseAccountHandle("https://www.threads.com/@profullstack", "threads")
        .handle,
    ).toBe("profullstack");
  });

  it("reads a Bluesky profile URL", () => {
    expect(
      parseAccountHandle(
        "https://bsky.app/profile/chovyfu.bsky.social",
        "bluesky",
      ).handle,
    ).toBe("chovyfu.bsky.social");
    // A bare handle contains dots but no path — it must not be read as a URL.
    expect(parseAccountHandle("chovyfu.bsky.social", "bluesky").handle).toBe(
      "chovyfu.bsky.social",
    );
  });

  it("reads the instance out of a Mastodon URL", () => {
    const r = parseAccountHandle("https://fosstodon.org/@chovy", "mastodon");
    expect(r.handle).toBe("chovy");
    expect(r.host).toBe("fosstodon.org");
  });

  it("does not mangle a URL for the wrong platform", () => {
    // Pasting a LinkedIn URL into the X field is user error, not ours to
    // silently reinterpret — keep it so the platform rejects it plainly.
    const r = parseAccountHandle(
      "https://www.linkedin.com/in/anthonyettinger/",
      "x",
    );
    expect(r.handle).toBe("https://www.linkedin.com/in/anthonyettinger/");
  });

  it("returns empty for empty input", () => {
    expect(parseAccountHandle("", "x").handle).toBe("");
    expect(parseAccountHandle("   ", "facebook_page").handle).toBe("");
  });
});
