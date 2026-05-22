// GitHub App helpers — JWT signing, installation token exchange, and a
// thin fetch wrapper. Zero external deps: just Node's crypto + fetch.
//
// GitHub Apps authenticate in two phases:
//   1. App JWT — RS256-signed with our private key, used to call /app
//      endpoints and to MINT installation tokens.
//   2. Installation token — short-lived (1h) OAuth-style token scoped to
//      one installation; used for all repo reads/writes.
//
// We cache installation tokens in github_installations.access_token until
// just before they expire to avoid re-minting on every request.

import crypto from "node:crypto";
import { env } from "@/lib/env";

const GH_API = "https://api.github.com";

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: "all" | "selected";
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  language: string | null;
  pushed_at: string | null;
  html_url: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

interface AppInstallation {
  id: number;
  account: {
    login: string;
    id: number;
    type: "User" | "Organization";
  };
  app_id: number;
  target_type: string;
  permissions: Record<string, string>;
  suspended_at: string | null;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Sign a GitHub App JWT (RS256). Valid for 10 minutes per GitHub spec. */
export function signAppJwt(): string {
  if (!env.githubAppId) {
    throw new Error("GITHUB_APP_ID is not configured.");
  }
  if (!env.githubAppPrivateKey) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  // 60s clock-skew slack on iat; max 10 minute lifetime.
  const payload = {
    iat: now - 30,
    exp: now + 9 * 60,
    iss: env.githubAppId,
  };
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  // Normalize PEM line endings: Railway env vars sometimes arrive with
  // literal "\n" sequences instead of real newlines.
  const pem = env.githubAppPrivateKey.replace(/\\n/g, "\n");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), pem);
  return `${signingInput}.${b64url(sig)}`;
}

async function ghFetch(
  path: string,
  init: RequestInit & { token: string },
): Promise<Response> {
  const { token, headers, ...rest } = init;
  const res = await fetch(`${GH_API}${path}`, {
    ...rest,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "CrawlProof/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      ...(headers || {}),
    },
  });
  return res;
}

/**
 * Mint a fresh installation token. ~1 hour lifetime. Callers should cache
 * via persistInstallationToken() to avoid the round-trip on every call.
 */
export async function mintInstallationToken(
  installationId: number | string,
): Promise<InstallationTokenResponse> {
  const jwt = signAppJwt();
  const res = await ghFetch(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST", token: jwt },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mint installation token failed: ${res.status} ${text}`);
  }
  return (await res.json()) as InstallationTokenResponse;
}

/** Look up the installation metadata (used by the install callback). */
export async function getInstallation(
  installationId: number | string,
): Promise<AppInstallation> {
  const jwt = signAppJwt();
  const res = await ghFetch(`/app/installations/${installationId}`, {
    token: jwt,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Get installation failed: ${res.status} ${text}`);
  }
  return (await res.json()) as AppInstallation;
}

/**
 * List all repos this installation has been granted. Handles pagination —
 * GitHub caps at 100 per page; we iterate until empty. Designed to work
 * cleanly for users with hundreds of repos.
 */
export async function listInstallationRepos(
  installationToken: string,
): Promise<GhRepo[]> {
  const all: GhRepo[] = [];
  for (let page = 1; ; page++) {
    const res = await ghFetch(
      `/installation/repositories?per_page=100&page=${page}`,
      { token: installationToken },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`List repos failed: ${res.status} ${text}`);
    }
    const body = (await res.json()) as { repositories: GhRepo[] };
    if (!body.repositories || body.repositories.length === 0) break;
    all.push(...body.repositories);
    if (body.repositories.length < 100) break;
    if (page > 50) break; // hard cap — 5000 repos is plenty
  }
  return all;
}

/**
 * Convert an App Manifest code into a fully-provisioned GitHub App. This
 * is the one-shot endpoint that returns the App ID, PEM, client id/secret,
 * webhook secret, and slug — i.e. everything we need to paste into env.
 * GitHub returns 201 once, then the code is consumed. See:
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */
export interface AppManifestConversionResponse {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
  owner: { login: string };
  html_url: string;
}

export async function convertAppManifest(
  code: string,
): Promise<AppManifestConversionResponse> {
  const res = await fetch(`${GH_API}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "CrawlProof/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`App manifest conversion failed: ${res.status} ${text}`);
  }
  return (await res.json()) as AppManifestConversionResponse;
}
