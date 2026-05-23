import fs from "node:fs/promises";
import net from "node:net";
import maxmind, { type CityResponse, type Reader } from "maxmind";
import { env } from "@/lib/env";

export interface GeoLocation {
  countryCode: string;
  countryName: string;
  regionCode: string;
  regionName: string;
  city: string;
  timezone: string;
}

let readerPromise: Promise<Reader<CityResponse> | null> | null = null;

export function clientIpFromHeaders(headers: Headers) {
  const forwardedFor = headers.get("x-forwarded-for");
  const firstForwarded = forwardedFor?.split(",")[0]?.trim();
  return (
    sanitizeIp(headers.get("cf-connecting-ip")) ??
    sanitizeIp(headers.get("x-real-ip")) ??
    sanitizeIp(firstForwarded) ??
    sanitizeIp(headers.get("x-client-ip")) ??
    null
  );
}

export async function lookupGeo(ip: string | null): Promise<GeoLocation | null> {
  const cleanIp = sanitizeIp(ip);
  if (!cleanIp || isPrivateOrLocalIp(cleanIp)) return null;

  const reader = await getReader();
  if (!reader) return null;

  const result = reader.get(cleanIp);
  if (!result) return null;

  return {
    countryCode: result.country?.iso_code ?? "",
    countryName: result.country?.names?.en ?? "",
    regionCode: result.subdivisions?.[0]?.iso_code ?? "",
    regionName: result.subdivisions?.[0]?.names?.en ?? "",
    city: result.city?.names?.en ?? "",
    timezone: result.location?.time_zone ?? "",
  };
}

function getReader() {
  if (!readerPromise) {
    readerPromise = openReader();
  }
  return readerPromise;
}

async function openReader() {
  const dbPath = env.geoLite2CityDbPath;
  if (!dbPath) return null;

  try {
    await fs.access(dbPath);
    return await maxmind.open<CityResponse>(dbPath, {
      cache: { max: 10_000 },
      watchForUpdates: true,
      watchForUpdatesNonPersistent: true,
    });
  } catch {
    return null;
  }
}

function sanitizeIp(value: string | null | undefined) {
  if (!value) return null;
  let ip = value.trim();
  if (!ip) return null;

  if (ip.startsWith("[") && ip.includes("]")) {
    ip = ip.slice(1, ip.indexOf("]"));
  } else if (ip.includes(":") && ip.includes(".") && ip.split(":").length === 2) {
    ip = ip.split(":")[0];
  }

  return net.isIP(ip) ? ip : null;
}

function isPrivateOrLocalIp(ip: string) {
  if (ip === "::1" || ip === "127.0.0.1") return true;

  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }

  const normalized = ip.toLowerCase();
  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}
