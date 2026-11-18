import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { FunnelBeacon } from "@/components/funnel-beacon";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Remembers ?src=outreach|ranking and a visitor id for funnel tracking. */}
      <FunnelBeacon />
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}
