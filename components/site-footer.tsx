import Link from "next/link";

const LINKS: Array<[string, string]> = [
  ["Pricing", "/pricing"],
  ["Blog", "/blog"],
  ["About", "/about"],
  ["Press", "/press"],
  ["Bot info", "/bot"],
  ["Privacy", "/privacy"],
  ["Terms", "/terms"],
];

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-[var(--color-border)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-[var(--color-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          © {new Date().getFullYear()}{" "}
          <span className="font-semibold text-[var(--color-fg)]">CrawlProof</span>
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-4 gap-y-1">
          {LINKS.map(([label, href]) => (
            <Link key={href} href={href} className="hover:text-[var(--color-fg)]">
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
