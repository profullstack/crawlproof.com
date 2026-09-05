/**
 * The fetch the audit reaches a customer's site with — paying when asked.
 *
 * A site behind an x402 gateway answers a crawler with 402 and an offer. With
 * `X402_PRIVATE_KEY` set, the client signs the offer with the shared crawler
 * wallet, buys the pass, files it by origin and presents it on every later
 * request to that site, so an audit of a gated site reads the site rather
 * than the sales page. Without the key this is the global fetch, unchanged.
 *
 * Only the page fetch goes through here. Link-status probes and uptime pings
 * touch many third-party domains per run, and paying a dollar to learn a
 * link's status would be waste; those stay on the plain fetch.
 *
 * Capped at five dollars a payment. The key is read through a non-literal
 * accessor because Next inlines `process.env.NAME` at build time.
 */

import { createClient } from "@profullstack/x402-client";

const key = process.env[["X402", "PRIVATE_KEY"].join("_")];

export const x402 = key ? createClient({ key, maxUsd: 5 }) : null;

export const paidFetch: typeof fetch = x402
  ? (input, init) => x402.fetch(input, init)
  : (input, init) => fetch(input, init);
