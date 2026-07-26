"use client";

import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-[var(--color-border)]">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 sm:px-6 py-10 text-sm text-[var(--color-muted)] md:grid-cols-5">
        <div>
          <div className="font-semibold text-[var(--color-fg)]">CrawlProof</div>
          <p className="mt-2">See your site the way AI crawlers do.</p>
        </div>
        <div>
          <div className="font-semibold text-[var(--color-fg)]">Product</div>
          <ul className="mt-2 space-y-1">
            <li><Link href="/pricing">Pricing</Link></li>
            <li><Link href="/slop">Slop Score</Link></li>
            <li><Link href="/get-guide">Get guide</Link></li>
            <li><Link href="/recent">Recent scans</Link></li>
            <li><Link href="/blog">Blog</Link></li>
          </ul>
        </div>
        <div>
          <div className="font-semibold text-[var(--color-fg)]">Company</div>
          <ul className="mt-2 space-y-1">
            <li><Link href="/about">About</Link></li>
            <li><Link href="/press">Press &amp; News</Link></li>
            <li><Link href="/bot">Bot info</Link></li>
          </ul>
        </div>
        <div>
          <div className="font-semibold text-[var(--color-fg)]">Partners</div>
          <ul className="mt-2 space-y-1">
            <li>
              <a href="https://vu1nz.com" target="_blank" rel="noreferrer">
                Vu1nz scanner
              </a>
            </li>
          </ul>
        </div>
        <div>
          <div className="font-semibold text-[var(--color-fg)]">Legal</div>
          <ul className="mt-2 space-y-1">
            <li><Link href="/privacy">Privacy</Link></li>
            <li><Link href="/terms">Terms</Link></li>
          </ul>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 pb-8 text-xs text-[var(--color-muted)]">
        © {new Date().getFullYear()} CrawlProof
      </div>
    </footer>
  );
}
