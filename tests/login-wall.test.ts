import { describe, it, expect } from "vitest";
import { looksLikeLoginWall } from "@/lib/outreach/loginWall";

// The exact redirect Instagram served for a seed search URL: HTTP 200, but
// bounced onto the login page with the requested URL preserved in ?next=.
const IG_REQUESTED =
  "https://www.instagram.com/explore/search/keyword/?q=military%203d%20modeling%20games";
const IG_FINAL =
  "https://www.instagram.com/accounts/login/?next=https%3A%2F%2Fwww.instagram.com%2Fexplore%2Fsearch%2Fkeyword%2F%3Fq%3Dmilitary%2B3d%2Bmodeling%2Bgames%26__coig_login%3D1";

describe("looksLikeLoginWall", () => {
  it("catches the Instagram redirect that reported as 'no businesses found'", () => {
    const v = looksLikeLoginWall({ requestedUrl: IG_REQUESTED, finalUrl: IG_FINAL });
    expect(v.loginRequired).toBe(true);
    expect(v.reason).toMatch(/accounts\/login/);
    expect(v.reason).toMatch(/return parameter/);
  });

  it("catches it from the rendered password field alone, without the redirect", () => {
    const v = looksLikeLoginWall({
      requestedUrl: IG_REQUESTED,
      finalUrl: IG_REQUESTED,
      html: '<form><input name="username"><input type="password" name="pass"></form>',
    });
    expect(v.loginRequired).toBe(true);
    expect(v.reason).toMatch(/password field/);
  });

  it("recognises other common login routes", () => {
    for (const path of [
      "/login",
      "/signin",
      "/sign-in",
      "/users/sign_in",
      "/session/new",
      "/auth/login",
    ]) {
      const v = looksLikeLoginWall({
        requestedUrl: "https://dir.test/browse",
        finalUrl: `https://dir.test${path}?return_to=%2Fbrowse`,
      });
      expect(v.loginRequired, path).toBe(true);
    }
  });

  it("does not misfire on a directory with a 'Log in' link in the header", () => {
    const v = looksLikeLoginWall({
      requestedUrl: "https://dir.test/browse",
      finalUrl: "https://dir.test/browse",
      html: '<header><a href="/login">Log in</a></header><ul><li><a href="https://acme.test">Acme</a></li></ul>',
    });
    expect(v.loginRequired).toBe(false);
  });

  it("does not misfire when the user deliberately seeded a login page", () => {
    const v = looksLikeLoginWall({
      requestedUrl: "https://dir.test/login",
      finalUrl: "https://dir.test/login",
      html: '<input type="password">',
    });
    expect(v.loginRequired).toBe(false);
  });

  it("does not treat an ordinary redirect as a login wall", () => {
    const v = looksLikeLoginWall({
      requestedUrl: "https://dir.test/browse",
      finalUrl: "https://dir.test/browse/page-1",
      html: "<ul><li><a href='https://acme.test'>Acme</a></li></ul>",
    });
    expect(v.loginRequired).toBe(false);
  });

  it("does not treat a bot challenge as a login wall", () => {
    const v = looksLikeLoginWall({
      requestedUrl: "https://cf.test/search",
      finalUrl: "https://cf.test/search",
      html: "<title>Just a moment...</title><div id='challenge-running'></div>",
    });
    expect(v.loginRequired).toBe(false);
  });

  it("catches a cross-host SSO bounce", () => {
    const v = looksLikeLoginWall({
      requestedUrl: "https://dir.test/browse",
      finalUrl: "https://accounts.sso.test/signin?continue=https%3A%2F%2Fdir.test%2Fbrowse",
    });
    expect(v.loginRequired).toBe(true);
  });

  it("survives malformed URLs without throwing", () => {
    expect(looksLikeLoginWall({ requestedUrl: "not a url" }).loginRequired).toBe(false);
  });
});
