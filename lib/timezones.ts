// Common IANA timezones shown at the top of pickers, followed by the
// full Intl list. We can't trim the long tail (someone is going to live
// in Pacific/Chatham), but pulling the popular ones up front keeps the
// dropdown usable for the 95% case.

const COMMON_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function listTimezones(): { common: string[]; all: string[] } {
  const supported = typeof (Intl as any).supportedValuesOf === "function"
    ? ((Intl as any).supportedValuesOf("timeZone") as string[])
    : [];
  const seen = new Set(COMMON_TIMEZONES);
  const rest = supported.filter((tz) => !seen.has(tz)).sort();
  return { common: COMMON_TIMEZONES, all: rest };
}

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    // Intl throws on an unknown zone — cheap one-shot validator.
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
