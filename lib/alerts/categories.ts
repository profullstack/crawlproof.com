// Starter alert categories (PRD §6). Each template compiles the user's single
// input (brand / name / domain / keyword) down to a ValueSERP query with the
// operator syntax hidden behind a friendly label.

import { normalizeDomain } from "./dedupe";

export type Recency = "day" | "week" | "month" | "any";

export type AlertCategoryKey =
  | "brand"
  | "name"
  | "competitor"
  | "backlink"
  | "buying_intent"
  | "community"
  | "reputation"
  | "impersonation"
  | "guest_post"
  | "press"
  | "jobs"
  | "deals"
  | "legal"
  | "events"
  | "research"
  | "custom";

export type CompiledAlert = {
  query: string;
  confirmBacklink: boolean;
  backlinkDomain: string | null;
  label: string;
};

export type AlertCategory = {
  key: AlertCategoryKey;
  title: string;
  template: string; // user-facing, ___ is the input slot
  inputLabel: string;
  inputPlaceholder: string;
  defaultRecency: Recency;
  // One of the five recommended onboarding defaults (PRD §6 note).
  launchSet: boolean;
  // People-tracking templates are withheld from the launch category set
  // pending a trust-and-safety / GDPR policy (critique fix).
  gated?: boolean;
  compile: (term: string) => CompiledAlert;
};

// Quote a term as an exact phrase when it contains whitespace.
function phrase(term: string): string {
  const t = term.trim();
  if (!t) return "";
  return /\s/.test(t) ? `"${t}"` : `"${t}"`;
}

function label(prefix: string, term: string): string {
  return `${prefix} ${term.trim()}`.trim();
}

const plain = (query: string, lbl: string): CompiledAlert => ({
  query,
  confirmBacklink: false,
  backlinkDomain: null,
  label: lbl,
});

export const ALERT_CATEGORIES: AlertCategory[] = [
  {
    key: "brand",
    title: "Brand mentions",
    template: "Track new mentions of ___",
    inputLabel: "Brand or company",
    inputPlaceholder: "Acme",
    defaultRecency: "week",
    launchSet: true,
    compile: (term) => plain(phrase(term), label("Brand mentions of", term)),
  },
  {
    key: "name",
    title: "Your name",
    template: "Track mentions of your name",
    inputLabel: "Full name",
    inputPlaceholder: "Jane Doe",
    defaultRecency: "week",
    launchSet: true,
    gated: true,
    compile: (term) => plain(phrase(term), label("Mentions of", term)),
  },
  {
    key: "competitor",
    title: "Competitor watch",
    template: "Track a competitor",
    inputLabel: "Competitor",
    inputPlaceholder: "Globex",
    defaultRecency: "week",
    launchSet: true,
    compile: (term) =>
      plain(`${phrase(term)} (launches OR announces OR review)`, label("Competitor watch:", term)),
  },
  {
    key: "backlink",
    title: "New backlinks",
    template: "Get alerted when a new site links to ___",
    inputLabel: "Your domain",
    inputPlaceholder: "acme.com",
    defaultRecency: "week",
    launchSet: true,
    compile: (term) => {
      const domain = normalizeDomain(term);
      return {
        query: `"${domain}" -site:${domain}`,
        confirmBacklink: true,
        backlinkDomain: domain,
        label: label("New backlinks to", domain),
      };
    },
  },
  {
    key: "buying_intent",
    title: "Buying intent",
    template: "People asking for tools like yours",
    inputLabel: "Category or competitor",
    inputPlaceholder: "project management",
    defaultRecency: "week",
    launchSet: true,
    compile: (term) => {
      const t = term.trim();
      return plain(
        `"best ${t} for" OR "alternative to ${t}"`,
        label("Buying intent:", term),
      );
    },
  },
  {
    key: "community",
    title: "Community questions",
    template: "New Reddit/Quora/SO questions about ___",
    inputLabel: "Topic",
    inputPlaceholder: "vector databases",
    defaultRecency: "week",
    launchSet: false,
    compile: (term) =>
      plain(
        `${phrase(term)} (site:reddit.com OR site:quora.com OR site:stackoverflow.com)`,
        label("Community questions about", term),
      ),
  },
  {
    key: "reputation",
    title: "Reputation risk",
    template: "Complaints or scam mentions of ___",
    inputLabel: "Brand",
    inputPlaceholder: "Acme",
    defaultRecency: "week",
    launchSet: false,
    gated: true,
    compile: (term) =>
      plain(`${phrase(term)} (scam OR complaint OR problem)`, label("Reputation risk:", term)),
  },
  {
    key: "impersonation",
    title: "Impersonation & security",
    template: "Fake sites or breach mentions of ___",
    inputLabel: "Brand",
    inputPlaceholder: "Acme",
    defaultRecency: "week",
    launchSet: false,
    gated: true,
    compile: (term) =>
      plain(
        `${phrase(term)} (fake OR phishing OR breach OR leaked)`,
        label("Impersonation & security:", term),
      ),
  },
  {
    key: "guest_post",
    title: "Guest post spots",
    template: "Sites accepting posts in your niche",
    inputLabel: "Niche",
    inputPlaceholder: "SaaS marketing",
    defaultRecency: "month",
    launchSet: false,
    compile: (term) =>
      plain(`"write for us" ${term.trim()}`, label("Guest post spots:", term)),
  },
  {
    key: "press",
    title: "Press coverage",
    template: "New press releases about ___",
    inputLabel: "Brand or topic",
    inputPlaceholder: "Acme",
    defaultRecency: "week",
    launchSet: false,
    compile: (term) =>
      plain(
        `${term.trim()} (site:prnewswire.com OR site:businesswire.com)`,
        label("Press coverage:", term),
      ),
  },
  {
    key: "jobs",
    title: "Jobs & hiring signals",
    template: "New roles matching ___",
    inputLabel: "Job title",
    inputPlaceholder: "Head of Growth",
    defaultRecency: "week",
    launchSet: false,
    compile: (term) =>
      plain(
        `${phrase(term)} (site:linkedin.com/jobs OR site:indeed.com)`,
        label("Jobs & hiring:", term),
      ),
  },
  {
    key: "deals",
    title: "Deals & restocks",
    template: "Price drops or restocks for ___",
    inputLabel: "Product",
    inputPlaceholder: "RTX 5090",
    defaultRecency: "day",
    launchSet: false,
    compile: (term) =>
      plain(`${phrase(term)} (deal OR sale OR "in stock")`, label("Deals & restocks:", term)),
  },
  {
    key: "legal",
    title: "Legal & regulatory",
    template: "Lawsuits or investigations naming ___",
    inputLabel: "Company",
    inputPlaceholder: "Acme Inc",
    defaultRecency: "week",
    launchSet: false,
    gated: true,
    compile: (term) =>
      plain(
        `${phrase(term)} (lawsuit OR fined OR investigation)`,
        label("Legal & regulatory:", term),
      ),
  },
  {
    key: "events",
    title: "Events & launches",
    template: "Conferences or launches in your space",
    inputLabel: "Topic",
    inputPlaceholder: "AI infrastructure",
    defaultRecency: "month",
    launchSet: false,
    compile: (term) =>
      plain(`${term.trim()} (conference OR summit OR launches) 2026`, label("Events & launches:", term)),
  },
  {
    key: "research",
    title: "New research",
    template: "New papers on ___",
    inputLabel: "Topic",
    inputPlaceholder: "retrieval augmentation",
    defaultRecency: "month",
    launchSet: false,
    compile: (term) =>
      plain(
        `${term.trim()} (site:arxiv.org OR site:pubmed.ncbi.nlm.nih.gov)`,
        label("New research on", term),
      ),
  },
  {
    key: "custom",
    title: "Custom query",
    template: "Power users write raw operators",
    inputLabel: "Raw search query",
    inputPlaceholder: '"acme" (review OR launch) -site:acme.com',
    defaultRecency: "week",
    launchSet: false,
    compile: (term) => plain(term.trim(), term.trim().slice(0, 80) || "Custom query"),
  },
];

const BY_KEY = new Map(ALERT_CATEGORIES.map((c) => [c.key, c]));

export function getCategory(key: string): AlertCategory | undefined {
  return BY_KEY.get(key as AlertCategoryKey);
}

export function isCategoryKey(key: string): key is AlertCategoryKey {
  return BY_KEY.has(key as AlertCategoryKey);
}

// The five recommended onboarding defaults (PRD §6): brand, name, one
// competitor, one buying-intent query, and new backlinks.
export function launchDefaults(): AlertCategory[] {
  return ALERT_CATEGORIES.filter((c) => c.launchSet);
}
