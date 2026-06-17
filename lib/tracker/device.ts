// Lightweight, dependency-free User-Agent parsing for the drop-in tracker.
// We only need coarse buckets for analytics — device type, browser family,
// and OS family — not a full UA database. Anything we can't confidently
// classify falls back to "" (matching the empty-string defaults used by the
// geo rollups) so the dashboard can simply skip unknowns.

export interface DeviceInfo {
  /** "mobile" | "tablet" | "desktop" | "bot" | "" */
  deviceType: string;
  /** Browser family, e.g. "Chrome", "Safari", "Firefox", "Edge". */
  browser: string;
  /** OS family, e.g. "Windows", "macOS", "iOS", "Android", "Linux". */
  os: string;
}

const EMPTY: DeviceInfo = { deviceType: "", browser: "", os: "" };

// Substring needles that mark a non-human client. Kept loose on purpose —
// categorize() already does the authoritative bot bucketing; this is just so
// device stats don't get polluted by obvious crawlers.
const BOT_RE = /bot\b|crawler|spider|scraper|headless|preview|fetch|monitor|http-client|axios|curl|wget|python-requests|go-http/i;

function detectOs(ua: string): string {
  // Order matters: iOS/iPadOS report "like Mac OS X", and Android UAs also
  // contain "Linux", so the more specific tokens must be checked first.
  if (/windows phone/i.test(ua)) return "Windows Phone";
  if (/windows nt|win64|win32|windows/i.test(ua)) return "Windows";
  if (/android/i.test(ua)) return "Android";
  if (/(iphone|ipad|ipod)/i.test(ua)) return "iOS";
  if (/cros/i.test(ua)) return "ChromeOS";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return "";
}

function detectBrowser(ua: string): string {
  // Edge / Opera / Samsung masquerade as Chrome, and Chrome masquerades as
  // Safari, so check the more specific tokens before the generic ones.
  if (/edg(a|ios|e)?\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung Internet";
  if (/ucbrowser/i.test(ua)) return "UC Browser";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/chrome|crios|chromium/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua)) return "Safari";
  if (/msie|trident/i.test(ua)) return "Internet Explorer";
  return "";
}

function detectDeviceType(ua: string): string {
  if (/ipad|tablet|playbook|silk|kindle/i.test(ua)) return "tablet";
  // Android phones say "Mobile"; Android tablets omit it.
  if (/android/i.test(ua)) return /mobile/i.test(ua) ? "mobile" : "tablet";
  if (/iphone|ipod/i.test(ua)) return "mobile";
  if (/mobi|mobile|phone|iemobile|blackberry|bb10|opera mini/i.test(ua)) {
    return "mobile";
  }
  return "desktop";
}

/**
 * Parse a raw User-Agent header into coarse analytics buckets. Returns empty
 * strings for fields we can't classify; never throws.
 */
export function parseDevice(userAgent: string | null | undefined): DeviceInfo {
  const ua = (userAgent ?? "").trim();
  if (!ua) return EMPTY;
  if (BOT_RE.test(ua)) {
    return { deviceType: "bot", browser: "", os: "" };
  }
  return {
    deviceType: detectDeviceType(ua),
    browser: detectBrowser(ua),
    os: detectOs(ua),
  };
}
