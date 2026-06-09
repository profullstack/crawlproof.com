import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Team",
  description:
    "Meet the people behind CrawlProof — the SEO, AEO, and GEO auditing platform built for the AI-search era.",
  alternates: { canonical: "/team" },
  openGraph: {
    title: "Team · CrawlProof",
    description:
      "Meet the people behind CrawlProof — the SEO, AEO, and GEO auditing platform built for the AI-search era.",
    url: "/team",
  },
};

const TEAM = [
  {
    name: "Phillip Harrington",
    role: "Founder & CEO",
    bio: "Full-stack engineer and serial builder who has shipped products across crypto, media, and developer tooling. Built CrawlProof to solve a gap he hit firsthand: there was no tool that showed exactly what LLM crawlers and answer engines actually see on a page.",
    links: [
      { label: "GitHub", href: "https://github.com/profullstack" },
      { label: "LinkedIn", href: "https://www.linkedin.com/in/profullstack" },
    ],
  },
];

export default function TeamPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16">
      <h1 className="text-4xl font-extrabold">Team</h1>
      <p className="mt-4 text-lg text-[var(--color-muted)]">
        CrawlProof is a small, focused team obsessed with making sure your content
        gets found — and cited — by AI.
      </p>

      <ul className="mt-12 space-y-12">
        {TEAM.map((person) => (
          <li key={person.name} className="flex flex-col gap-2 sm:flex-row sm:gap-8">
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-[var(--color-border)] text-3xl font-bold text-[var(--color-muted)] select-none">
              {person.name
                .split(" ")
                .map((n) => n[0])
                .join("")}
            </div>
            <div>
              <h2 className="text-xl font-bold">{person.name}</h2>
              <p className="text-sm font-medium text-[var(--color-accent)]">{person.role}</p>
              <p className="mt-2 text-[var(--color-muted)]">{person.bio}</p>
              {person.links.length > 0 && (
                <ul className="mt-3 flex gap-4 text-sm">
                  {person.links.map((link) => (
                    <li key={link.href}>
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="underline text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-16 rounded-lg border border-[var(--color-border)] p-6 text-sm text-[var(--color-muted)]">
        <p>
          Interested in working together?{" "}
          <a href="/hire" className="underline text-[var(--color-fg)]">
            Hire us
          </a>{" "}
          for SEO / AEO consulting, or reach out at{" "}
          <a href="mailto:hello@crawlproof.com" className="underline text-[var(--color-fg)]">
            hello@crawlproof.com
          </a>
          .
        </p>
      </div>
    </main>
  );
}
