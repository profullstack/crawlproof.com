// Compute the next publish slot for a site given its publish_days +
// publish_hour. ISO weekday: 1=Mon ... 7=Sun (matches schema default
// '{1,2,3,4,5}' = weekdays).

const DAY_MS = 24 * 60 * 60 * 1000;

function isoWeekday(d: Date): number {
  // JS getDay: 0=Sun..6=Sat. Convert to ISO 1=Mon..7=Sun.
  const js = d.getUTCDay();
  return js === 0 ? 7 : js;
}

export function nextPublishAt(
  publishDays: number[],
  publishHour: number,
  fromTime: Date = new Date(),
): Date | null {
  if (publishDays.length === 0) return null;
  const allowed = new Set(publishDays);

  // Walk forward at most 8 days. Today counts if the hour hasn't passed yet.
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(fromTime.getTime() + i * DAY_MS);
    candidate.setUTCHours(publishHour, 0, 0, 0);
    if (candidate.getTime() <= fromTime.getTime()) continue;
    if (allowed.has(isoWeekday(candidate))) return candidate;
  }
  return null;
}
