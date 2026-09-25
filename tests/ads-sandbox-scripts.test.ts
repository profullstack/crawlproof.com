import { describe, expect, it } from "vitest";
import { GET } from "@/app/ad.js/route";

async function tag(): Promise<string> {
  const res = await GET();
  return await res.text();
}

describe("ad.js sandbox", () => {
  it("never grants allow-same-origin", async () => {
    // With allow-scripts AND allow-same-origin together, the framed document
    // can reach frameElement and delete its own sandbox attribute — which is
    // not a sandbox. This assertion is the standing rule, in executable form.
    //
    // Comments are stripped first: the tag explains in prose why the pair is
    // never granted, and the rule is about the value, not the file.
    const js = (await tag()).replace(/^\s*\/\/.*$/gm, "");
    expect(js).not.toContain("allow-same-origin");
  });

  it("grants scripts only to the media that can report playback", async () => {
    const js = await tag();
    expect(js).toContain("if (res.media === 'video' || res.media === 'audio') sandbox += ' allow-scripts';");
    // The base sandbox, used for every other fill, stays script-free.
    expect(js).toContain(
      "var sandbox = 'allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation';",
    );
  });

  it("still keeps the click-out permissions it always had", async () => {
    const js = await tag();
    expect(js).toContain("allow-popups");
    expect(js).toContain("allow-top-navigation-by-user-activation");
  });

  it("grants autoplay only to video, as before", async () => {
    const js = await tag();
    expect(js).toContain("if (res.media === 'video') iframe.setAttribute('allow', 'autoplay');");
  });
});
