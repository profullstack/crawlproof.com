// The attribution cookie: `<code>.<clicked-at unix seconds>`. Set by the click
// route on a navigation that carried ?oa=, read when the user signs in or
// starts a purchase. Pure, so the middleware and tests can share it.

export const COOKIE_NAME = "oa";

export type Attribution = { code: string; clickedAt: Date };

export function encodeCookie(a: Attribution): string {
  return `${a.code}.${Math.floor(a.clickedAt.getTime() / 1000)}`;
}

export function decodeCookie(value: string | null | undefined): Attribution | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const code = value.slice(0, dot);
  const secs = Number(value.slice(dot + 1));
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(code) || !Number.isFinite(secs) || secs <= 0) return null;
  return { code, clickedAt: new Date(secs * 1000) };
}

export function expiresAt(clickedAt: Date, windowDays: number): Date {
  return new Date(clickedAt.getTime() + windowDays * 86_400_000);
}

export function withinWindow(clickedAt: Date, windowDays: number, now = new Date()): boolean {
  return now.getTime() <= expiresAt(clickedAt, windowDays).getTime() && clickedAt.getTime() <= now.getTime() + 60_000;
}

/**
 * Whether a request is a top-level navigation. Only a navigation sets
 * attribution (spec, "Links and attribution" rule 1): an image, frame,
 * script or prefetch that carries ?oa= sets nothing.
 */
export function isNavigation(headers: { get(name: string): string | null }): boolean {
  const dest = headers.get("sec-fetch-dest");
  const mode = headers.get("sec-fetch-mode");
  if (dest || mode) return dest === "document" && (mode === "navigate" || mode === null);
  const accept = headers.get("accept") ?? "";
  return accept.includes("text/html");
}
