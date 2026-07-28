import { getProviderCosts, type CostStatus } from "@/lib/provider-costs";

const STATUS_STYLE: Record<CostStatus, { label: string; className: string }> = {
  ok: { label: "OK", className: "text-emerald-500" },
  low: { label: "LOW", className: "text-amber-500" },
  critical: { label: "CRITICAL", className: "text-red-500" },
  error: { label: "ERROR", className: "text-red-500" },
  unconfigured: { label: "NOT SET", className: "text-[var(--color-muted)]" },
};

/**
 * Live provider balances. Rendered server-side on each admin load so the
 * figures are current rather than cached — this panel exists precisely to
 * catch a drain, and a stale number would defeat it.
 */
export async function ProviderCostsPanel() {
  const costs = await getProviderCosts();
  const needsAttention = costs.filter((c) => c.status === "critical" || c.status === "low");

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Provider balances</h2>
        {needsAttention.length > 0 && (
          <span className="text-sm text-amber-500">
            {needsAttention.length} need{needsAttention.length === 1 ? "s" : ""} attention
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Live, read on each page load. Only providers that expose a balance to an ordinary API key
        appear here — OpenAI and Anthropic require a separate admin key.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--color-muted)]">
              <th className="py-2 pr-4 font-normal">Provider</th>
              <th className="py-2 pr-4 font-normal">Remaining</th>
              <th className="py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {costs.map((c) => {
              const style = STATUS_STYLE[c.status];
              return (
                <tr key={c.provider} className="border-t border-[var(--color-border,#2a2a2a)]">
                  <td className="py-2 pr-4">{c.provider}</td>
                  <td className="py-2 pr-4 font-mono">
                    {c.display}
                    {c.usedFraction !== null && (
                      <span className="ml-2 text-[var(--color-muted)]">
                        ({Math.round(c.usedFraction * 100)}% used)
                      </span>
                    )}
                  </td>
                  <td className={`py-2 font-medium ${style.className}`}>{style.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {costs.some((c) => c.detail) && (
        <ul className="mt-3 space-y-1 text-xs text-[var(--color-muted)]">
          {costs
            .filter((c) => c.detail)
            .map((c) => (
              <li key={c.provider}>
                <span className="font-medium">{c.provider}:</span> {c.detail}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
