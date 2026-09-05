/**
 * The fetch the audit reaches a customer's site with — guarded, and paying
 * when asked.
 *
 * Guarded: the URL comes from a customer, so the host is resolved and
 * refused if any answer is private, and the final URL is checked again after
 * redirects. See lib/net-guard.ts. `CRAWLPROOF_ALLOW_PRIVATE_TARGETS=1`
 * switches that off for auditing a local server in development, and for
 * nothing else.
 *
 * Paying: a site behind an x402 gateway answers a crawler with 402 and an
 * offer. With `X402_PRIVATE_KEY` set, the client signs the offer with the
 * shared crawler wallet, buys the pass, files it by origin and presents it on
 * every later request to that site, so an audit of a gated site reads the
 * site rather than the sales page. Without the key it is the global fetch.
 *
 * Only the page fetch goes through here. Link-status probes and uptime pings
 * touch many third-party domains per run, and paying a dollar to learn a
 * link's status would be waste; those stay on the plain fetch.
 *
 * Capped at five dollars a payment. Both env keys are read through
 * non-literal accessors because Next inlines `process.env.NAME` at build.
 */

import { createClient } from "@profullstack/x402-client";

import { assertPublicTarget, PrivateTargetError } from "./net-guard";

const key = process.env[["X402", "PRIVATE_KEY"].join("_")];
const allowPrivate = process.env[["CRAWLPROOF", "ALLOW_PRIVATE_TARGETS"].join("_")] === "1";

export const x402 = key ? createClient({ key, maxUsd: 5 }) : null;

const underlying: typeof fetch = x402 ? (input, init) => x402.fetch(input, init) : (input, init) => fetch(input, init);

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export const paidFetch: typeof fetch = async (input, init) => {
  const url = urlOf(input);
  if (!allowPrivate) await assertPublicTarget(url);
  const res = await underlying(input, init);
  // A redirect can land inside even when the origin was public.
  if (!allowPrivate && res.url && new URL(res.url).hostname !== new URL(url).hostname) {
    try {
      await assertPublicTarget(res.url);
    } catch (err) {
      if (err instanceof PrivateTargetError) {
        res.body?.cancel().catch(() => {});
        throw err;
      }
      throw err;
    }
  }
  return res;
};
