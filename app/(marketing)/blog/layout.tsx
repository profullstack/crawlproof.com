import { AdUnit } from "@/components/ads/ad-unit";

/**
 * Ads run on /blog/** only — the editorial pages — and nowhere else on the
 * site. Scoping them to this layout keeps them off the marketing pages, the
 * app, and transactional email; the RSS route under /blog is a route handler
 * and never sees a layout, so the feed stays clean too.
 *
 * Both units leave `format` unset so /ad.js sizes them to the column: a
 * leaderboard on desktop, a mobile banner on narrow screens.
 */
export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <div className="mx-auto max-w-3xl px-4 sm:px-6 pb-16">
        <AdUnit />
        <AdUnit format="text_link" className="mt-6" />
      </div>
    </>
  );
}
