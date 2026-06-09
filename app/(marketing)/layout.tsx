import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { TrustedEngines } from "@/components/trusted-engines";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
      <TrustedEngines />
      <SiteFooter />
    </>
  );
}
