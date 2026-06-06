"use server";

import { lookup } from "node:dns/promises";
import net from "node:net";
import { revalidatePath } from "next/cache";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import {
  analyzeIntegration,
  extractIntegrationSource,
  type IntegrationAnalysis,
} from "@/lib/tracker/integration-analyzer";

type Ok<T = undefined> = { ok: true } & (T extends undefined ? {} : T);
type Err = { ok: false; error: string };

const MAX_INPUT_BYTES = 100_000;
const MAX_FETCH_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 10_000;

export async function analyzeTrackerIntegration(input: {
  projectId: string;
  name?: string;
  snippet: string;
}): Promise<Ok<{ id: string }> | Err> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return access;

  const snippet = input.snippet.trim();
  if (!snippet) return { ok: false, error: "Paste a script tag, URL, or JavaScript snippet." };
  if (Buffer.byteLength(snippet) > MAX_INPUT_BYTES) {
    return { ok: false, error: "Input is too large. Keep pasted snippets under 100 KB." };
  }

  const source = extractIntegrationSource(snippet);
  let fetched:
    | { text: string; bytes: number; contentType: string | null; status: number; url: string }
    | null = null;

  if (source.scriptUrl) {
    try {
      fetched = await fetchPublicText(source.scriptUrl);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not fetch integration script.",
      };
    }
  }

  const analysis = analyzeIntegration({
    originalInput: snippet,
    fetchedText: fetched?.text,
    fetchedBytes: fetched?.bytes,
    contentType: fetched?.contentType,
    httpStatus: fetched?.status,
  });
  if (fetched?.url && analysis.source.scriptUrl !== fetched.url) {
    analysis.source.scriptUrl = fetched.url;
    analysis.source.origin = new URL(fetched.url).origin;
  }

  const name = cleanName(input.name) ?? defaultName(analysis);
  const { data, error } = await access.supabase
    .from("tracker_integrations")
    .insert({
      project_id: input.projectId,
      created_by: access.userId,
      name,
      input: snippet,
      source_url: analysis.source.scriptUrl,
      status: "ready",
      http_status: analysis.source.httpStatus,
      content_type: analysis.source.contentType,
      script_sha256: analysis.source.sha256,
      script_bytes: analysis.source.fetchedBytes,
      analysis,
      fetched_at: fetched ? new Date().toISOString() : null,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/stats/integrations`);
  return { ok: true, id: data.id as string };
}

export async function deleteTrackerIntegration(input: {
  projectId: string;
  integrationId: string;
}): Promise<Ok | Err> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return access;

  const { error } = await access.supabase
    .from("tracker_integrations")
    .delete()
    .eq("id", input.integrationId)
    .eq("project_id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/stats/integrations`);
  return { ok: true };
}

async function fetchPublicText(rawUrl: string) {
  let current = await assertPublicHttpUrl(rawUrl);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetch(current.toString(), {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": "CrawlProof Integration Analyzer/1.0",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Script redirect did not include a location.");
      current = await assertPublicHttpUrl(new URL(location, current).toString());
      continue;
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_FETCH_BYTES) {
      throw new Error("Fetched script is too large. Limit is 1 MB.");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_FETCH_BYTES) {
      throw new Error("Fetched script is too large. Limit is 1 MB.");
    }

    return {
      text: buffer.toString("utf8"),
      bytes: buffer.byteLength,
      contentType: response.headers.get("content-type"),
      status: response.status,
      url: current.toString(),
    };
  }

  throw new Error("Too many redirects while fetching script.");
}

async function assertPublicHttpUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Script src must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP(S) script URLs can be fetched.");
  }
  if (!url.hostname.includes(".") && net.isIP(url.hostname) === 0) {
    throw new Error("Script host must be a public hostname.");
  }

  const addresses =
    net.isIP(url.hostname) === 0
      ? await lookup(url.hostname, { all: true, verbatim: true })
      : [{ address: url.hostname }];
  if (addresses.length === 0) throw new Error("Script host did not resolve.");
  if (addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new Error("Script URL resolves to a private or reserved address.");
  }
  return url;
}

function isPublicIp(address: string) {
  if (address.startsWith("::ffff:")) return isPublicIp(address.slice(7));
  if (net.isIP(address) === 4) {
    const parts = address.split(".").map((part) => Number(part));
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }

  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (normalized.startsWith("fe80:")) return false;
  return true;
}

function cleanName(value: string | undefined) {
  const name = value?.trim().replace(/\s+/g, " ").slice(0, 100);
  return name || null;
}

function defaultName(analysis: IntegrationAnalysis) {
  if (analysis.source.origin) return new URL(analysis.source.origin).hostname;
  if (analysis.source.inputType === "script-tag") return "Pasted script";
  return "Custom integration";
}
