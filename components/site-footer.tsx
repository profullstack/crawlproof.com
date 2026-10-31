import { Footer } from "@profullstack/footer/react";

const LINKS: Array<[string, string]> = [
  ["Pricing", "/pricing"],
  ["Blog", "/blog"],
  ["About", "/about"],
  ["Press", "/press"],
  ["Bot info", "/bot"],
  ["Merge N Launch", "https://luma.com/mergenlaunch"],
  ["Privacy", "/privacy"],
  ["Terms", "/terms"],
];

/** One shared footer carries CrawlProof's navigation and Profullstack links. */
export function SiteFooter() {
  return (
    <Footer
      site="https://crawlproof.com/"
      owner={{ name: "CrawlProof", url: "https://crawlproof.com/" }}
      links={LINKS.map(([label, href]) => ({ label, href }))}
    />
  );
}
