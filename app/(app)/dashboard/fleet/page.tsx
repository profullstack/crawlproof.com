import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FleetBar } from "./fleet-bar";

export const metadata = { title: "Fleet", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// The same fleet panel as w3bs.org/fleet and threatcrush.com/fleet: SSH login,
// HTTP, keyword, SSL and TCP checks in the user's one Fleet project, checked
// 24/7 with email and phone alerts. --fleetbar-* follow crawlproof's tokens.
const theme = {
  "--fleetbar-bg": "var(--color-bg)",
  "--fleetbar-surface": "var(--color-card)",
  "--fleetbar-fg": "var(--color-fg)",
  "--fleetbar-muted": "var(--color-muted)",
  "--fleetbar-border": "var(--color-border)",
  "--fleetbar-accent": "var(--color-accent)",
  "--fleetbar-accent-fg": "var(--color-accent-fg)",
  "--fleetbar-up": "var(--color-pass)",
  "--fleetbar-down": "var(--color-fail)",
  "--fleetbar-pending": "var(--color-warn)",
  "--fleetbar-paused": "var(--color-unknown)",
} as React.CSSProperties;

export default async function FleetPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login?redirect=%2Fdashboard%2Ffleet");
  return (
    <div className="space-y-4" style={theme}>
      <div>
        <h1 className="text-3xl font-bold">Fleet</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          SSH access checks and uptime for your servers, checked around the clock. The same fleet shows on w3bs.org/fleet and
          threatcrush.com/fleet.
        </p>
      </div>
      <FleetBar />
    </div>
  );
}
