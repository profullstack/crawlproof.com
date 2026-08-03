// /docs/stats-tracker is a legacy alias of /docs/statistics.
// Re-export the page but override metadata so search engines treat the
// canonical URL as /docs/statistics and don't index this as duplicate content.
export const metadata = {
  title: "Statistics",
  description:
    "Install the cookieless tracker, collect pageviews and interactions, and send custom events from any frontend stack.",
  alternates: { canonical: "/docs/statistics" },
};

export { default } from "../statistics/page";