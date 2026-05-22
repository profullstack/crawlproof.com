// Behind Railway's reverse proxy, Next.js's `request.url` reports the
// internal bind address (e.g. http://0.0.0.0:8080/...) instead of the
// public URL. That's correct per HTTP semantics — the Host header IS
// 0.0.0.0:8080 from the upstream perspective — but it breaks any code
// that uses `request.url` to build a public Location header on a
// redirect, because the browser then gets sent to the bind address.
//
// This helper picks the correct base by preferring x-forwarded-host +
// x-forwarded-proto (the values Railway's proxy adds), falling back to
// the raw Host header. It ignores 0.0.0.0 / 127.0.0.1 hostnames so they
// can never get baked into a Location header.

import { env } from "@/lib/env";

interface HeaderSource {
  get(name: string): string | null;
}

export function publicBaseUrlFromHeaders(headers: HeaderSource): string {
  const fwdHost = headers.get("x-forwarded-host");
  const fwdProto = headers.get("x-forwarded-proto");
  const rawHost = headers.get("host");

  const candidate = fwdHost ?? rawHost;
  const proto = fwdProto ?? "https";

  if (
    candidate &&
    !candidate.startsWith("0.0.0.0") &&
    !candidate.startsWith("127.0.0.1") &&
    !candidate.startsWith("localhost")
  ) {
    return `${proto}://${candidate}`.replace(/\/$/, "");
  }
  // Last-ditch fallback to the env (dev case where headers are sparse).
  return env.siteUrl.replace(/\/$/, "");
}

/** Build an absolute URL anchored at the public base. Use this instead
 *  of `new URL(path, request.url)` when constructing redirect Location
 *  values — `request.url` carries the internal host behind a proxy. */
export function publicUrl(headers: HeaderSource, path: string): string {
  const base = publicBaseUrlFromHeaders(headers);
  // path may include a fragment (#...) — preserve verbatim, don't pass
  // through URL() which would percent-encode the fragment payload.
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
