import { clientIpFromHeaders } from "@/lib/tracker/geo";

/** Railway sets X-Real-IP at its edge. Other forwarded headers can be supplied
 * by the caller and must not override that identity for click accounting.
 * https://docs.railway.com/networking/public-networking/specs-and-limits
 */
export function adClickIp(headers: Headers): string | null {
  if (!process.env.RAILWAY_ENVIRONMENT_ID) return clientIpFromHeaders(headers);
  const trusted = new Headers();
  const ip = headers.get("x-real-ip");
  if (ip) trusted.set("x-real-ip", ip);
  return clientIpFromHeaders(trusted);
}
