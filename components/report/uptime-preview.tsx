// Screenshot-style preview of the Uptime tab for the marketing homepage.
// Coded panel (fixed dark chrome) rather than a raster capture, matching the
// site's existing preview components.

const rows = [
  { name: "crawlproof.com", meta: "http · 60s", state: "up", latency: "142 ms" },
  { name: "api.crawlproof.com", meta: "http · /health", state: "up", latency: "88 ms" },
  { name: "db.acme.io:5432", meta: "tcp", state: "up", latency: "12 ms" },
  { name: "status.acme.io", meta: "http · 500", state: "down", latency: "—" },
];

export function UptimePreview() {
  return (
    <div
      className="rounded-xl border border-[var(--color-border)] bg-[#101820] p-5 shadow-2xl shadow-black/20 sm:p-6"
      aria-label="Uptime monitors panel: three monitors up, one down, with an open incident."
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold">Uptime Monitors</div>
        <div className="rounded-full border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.12)] px-2.5 py-1 text-xs font-semibold text-[#f87171]">
          1 down
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {rows.map((r) => {
          const down = r.state === "down";
          return (
            <div
              key={r.name}
              className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg bg-[#17202a] px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span style={{ color: down ? "#f87171" : "#6ee7b7" }}>●</span>
                  <span className="truncate font-mono text-sm">{r.name}</span>
                </div>
                <div className="ml-4 text-xs text-[var(--color-muted)]">{r.meta}</div>
              </div>
              <div
                className="text-right font-mono text-xs"
                style={{ color: down ? "#f87171" : "var(--color-muted)" }}
              >
                {down ? "connection refused" : r.latency}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-lg border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] p-3 text-xs">
        <span className="font-semibold text-[#f87171]">🔴 Down alert sent</span>
        <span className="text-[var(--color-muted)]"> · status.acme.io · email + Slack · 12s ago</span>
      </div>

      <p className="mt-4 text-xs text-[var(--color-muted)]">
        HTTP · Keyword · SSL-expiry · TCP — checked on your interval, with
        down &amp; recovery alerts to email, Slack, and Discord.
      </p>
    </div>
  );
}
