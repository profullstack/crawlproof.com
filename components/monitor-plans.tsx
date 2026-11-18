import { MONITOR_PLANS, priceLabel } from "@/lib/monitoring";
import { MonitorSubscribeButton } from "@/components/monitor-subscribe-button";

const FEATURES: Record<"solo" | "agency", string[]> = {
  solo: [
    "1 site re-audited every week",
    "Email when the score moves",
    "Shareable report link for every run",
  ],
  agency: [
    "Up to 20 client sites, re-audited every week",
    "Email when any client's score moves",
    "A shareable report link per run to send each client",
  ],
};

/** The two weekly-monitoring plans, with checkout buttons. */
export function MonitorPlans({ token }: { token?: string | null }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(["solo", "agency"] as const).map((id) => {
        const plan = MONITOR_PLANS[id];
        return (
          <div
            key={id}
            className={`card flex flex-col p-6 ${id === "agency" ? "border-[var(--color-accent)]" : ""}`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-xl font-bold">{plan.label}</h3>
              <div>
                <span className="text-3xl font-extrabold">{priceLabel(plan.amountCents)}</span>
                <span className="text-sm text-[var(--color-muted)]">/month</span>
              </div>
            </div>
            <p className="mt-2 text-sm text-[var(--color-muted)]">{plan.blurb}</p>
            <ul className="mt-4 flex-1 space-y-2 text-sm">
              {FEATURES[id].map((f) => (
                <li key={f} className="flex gap-2">
                  <span aria-hidden className="text-[var(--color-accent)]">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <div className="mt-6">
              <MonitorSubscribeButton
                plan={id}
                token={token}
                label={`Monitor weekly: ${priceLabel(plan.amountCents)}/mo`}
                primary={id === "agency"}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const MONITOR_PAYMENT_NOTE =
  "Pay by card (through PayPal) or crypto. Each month is paid up front, nothing renews automatically, and you can cancel from your dashboard at any time.";
