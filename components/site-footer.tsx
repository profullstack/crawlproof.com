import Link from "next/link";
import { Footer } from "@profullstack/footer/react";

const LINKS: Array<[string, string]> = [
  ["Pricing", "/pricing"],
  ["Blog", "/blog"],
  ["About", "/about"],
  ["Press", "/press"],
  ["Bot info", "/bot"],
  ["Privacy", "/privacy"],
  ["Terms", "/terms"],
];

/** Server component: a link row, then @profullstack/footer (copyright + Profullstack webring). */
export function SiteFooter() {
  return (
    <>
      <footer className="mt-24 border-t border-[var(--color-border)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-[var(--color-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="font-semibold text-[var(--color-fg)]">CrawlProof</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-4 gap-y-1">
            {LINKS.map(([label, href]) => (
              <Link key={href} href={href} className="hover:text-[var(--color-fg)]">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
      <div className="text-[var(--color-muted)]">
        <Footer site="https://crawlproof.com/" />
      </div>
    </>
  );
}
