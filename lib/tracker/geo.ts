import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
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

type GeoReaders = {
  explicit: Reader<CityResponse> | null;
  ipv4: Reader<CityResponse> | null;
  ipv6: Reader<CityResponse> | null;
};

const require = createRequire(import.meta.url);
let readerPromise: Promise<GeoReaders | null> | null = null;

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

  const readers = await getReaders();
  if (!readers) return null;

  const reader =
    readers.explicit ?? (net.isIPv4(cleanIp) ? readers.ipv4 : readers.ipv6);
  const result = reader?.get(cleanIp) as CityResponse | FlatGeoResponse | null | undefined;
  if (!result) return null;
  const flat = result as FlatGeoResponse;

  return {
    countryCode: nestedCountryCode(result) || flatText(flat.country_code),
    countryName: nestedCountryName(result) || flatText(flat.country_name),
    regionCode: nestedRegionCode(result) || flatText(flat.state1),
    regionName: nestedRegionName(result) || flatText(flat.state2),
    city: nestedCity(result) || flatText(flat.city),
    timezone: nestedTimezone(result) || flatText(flat.timezone),
  };
}

type FlatGeoResponse = {
  country_code?: unknown;
  country_name?: unknown;
  state1?: unknown;
  state2?: unknown;
  city?: unknown;
  timezone?: unknown;
};

function nestedCountryCode(result: CityResponse | FlatGeoResponse) {
  return "country" in result ? result.country?.iso_code ?? "" : "";
}

function nestedCountryName(result: CityResponse | FlatGeoResponse) {
  return "country" in result ? result.country?.names?.en ?? "" : "";
}

function nestedRegionCode(result: CityResponse | FlatGeoResponse) {
  return "subdivisions" in result ? result.subdivisions?.[0]?.iso_code ?? "" : "";
}

function nestedRegionName(result: CityResponse | FlatGeoResponse) {
  return "subdivisions" in result ? result.subdivisions?.[0]?.names?.en ?? "" : "";
}

function nestedCity(result: CityResponse | FlatGeoResponse) {
  return "city" in result && typeof result.city === "object"
    ? (result.city as CityResponse["city"])?.names?.en ?? ""
    : "";
}

function nestedTimezone(result: CityResponse | FlatGeoResponse) {
  return "location" in result ? result.location?.time_zone ?? "" : "";
}

function flatText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function getReaders() {
  if (!readerPromise) {
    readerPromise = openReaders();
  }
  return readerPromise;
}

async function openReaders(): Promise<GeoReaders | null> {
  const explicit = await openReaderIfReadable(env.geoLite2CityDbPath);
  if (explicit) return { explicit, ipv4: null, ipv6: null };

  const bundled = bundledDbPaths();
  const [ipv4, ipv6] = await Promise.all([
    openReaderIfReadable(bundled?.ipv4),
    openReaderIfReadable(bundled?.ipv6),
  ]);
  return ipv4 || ipv6 ? { explicit: null, ipv4, ipv6 } : null;
}

async function openReaderIfReadable(dbPath: string | null | undefined) {
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

function bundledDbPaths() {
  try {
    const packageJson = require.resolve(
      "@ip-location-db/geolite2-city-mmdb/package.json",
    );
    const root = path.dirname(packageJson);
    return {
      ipv4: path.join(root, "geolite2-city-ipv4.mmdb"),
      ipv6: path.join(root, "geolite2-city-ipv6.mmdb"),
    };
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
