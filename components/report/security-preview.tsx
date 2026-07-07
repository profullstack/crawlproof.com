// Screenshot-style preview of the Security / Exposed Services tab for the
// marketing homepage. Coded panel (fixed dark chrome), matching the site's
// existing preview components.

const ports = [
  { port: 443, service: "https", sev: "low", isNew: false },
  { port: 80, service: "http", sev: "low", isNew: false },
  { port: 22, service: "ssh", sev: "medium", isNew: false },
  { port: 6379, service: "redis", sev: "high", isNew: true },
  { port: 5432, service: "postgres", sev: "high", isNew: true },
];

const SEV_COLOR: Record<string, string> = {
  high: "#f87171",
  medium: "#fbbf24",
  low: "#6ee7b7",
};

export function SecurityPreview() {
  return (
    <div
      className="rounded-xl border border-[var(--color-border)] bg-[#101820] p-5 shadow-2xl shadow-black/20 sm:p-6"
      aria-label="Exposed services panel: a full port scan with two newly-exposed high-severity database ports."
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-bold">Exposed Services</div>
          <div className="font-mono text-xs text-[var(--color-muted)]">scan of acme.io</div>
        </div>
        <div className="rounded-full border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.12)] px-2.5 py-1 text-xs font-semibold text-[#f87171]">
          2 new
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {ports.map((p) => (
          <div
            key={p.port}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg bg-[#17202a] px-3 py-2.5"
          >
            <span
              className="w-14 text-xs font-semibold uppercase"
              style={{ color: SEV_COLOR[p.sev] }}
            >
              {p.sev}
            </span>
            <span className="font-mono text-sm">
              acme.io:<span className="font-bold">{p.port}</span>{" "}
              <span className="text-[var(--color-muted)]">({p.service})</span>
            </span>
            {p.isNew ? (
              <span className="rounded bg-[rgba(248,113,113,0.15)] px-2 py-0.5 text-right text-xs font-semibold text-[#f87171]">
                NEW
              </span>
            ) : (
              <span className="text-right text-xs text-[var(--color-muted)]">baseline</span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] p-3 text-xs">
        <span className="font-semibold text-[#f87171]">Port drift detected</span>
        <span className="text-[var(--color-muted)]">
          {" "}
          · Redis &amp; Postgres now reachable from the public internet
        </span>
      </div>

      <p className="mt-4 text-xs text-[var(--color-muted)]">
        Full 65,535-port scan of your owner-verified hosts. We baseline what&apos;s
        expected and alert only when something <em>new</em> gets exposed.
      </p>
    </div>
  );
}
