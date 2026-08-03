// Shared types and normalizers for the careers module. Kept free of Next.js
// and Supabase imports so both the server actions and the plain-Node tests can
// use it.

export const JOB_STATUSES = ["draft", "open", "closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// Review pipeline for an applicant: everything lands as `new`, and the
// reviewer moves it forward (shortlisted → accepted) or out (rejected).
export const APPLICATION_STATUSES = ["new", "shortlisted", "accepted", "rejected"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  new: "New",
  shortlisted: "Shortlisted",
  accepted: "Accepted",
  rejected: "Rejected",
};

export const EMPLOYMENT_TYPES = [
  "Full-time",
  "Part-time",
  "Contract",
  "Internship",
  "Temporary",
] as const;

// Where the work happens — orthogonal to employment type. Three values rather
// than a remote boolean because "hybrid" is the case a boolean can't express.
export const WORKPLACES = ["remote", "hybrid", "onsite"] as const;
export type Workplace = (typeof WORKPLACES)[number];

export const WORKPLACE_LABEL: Record<Workplace, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
};

export function isWorkplace(value: unknown): value is Workplace {
  return typeof value === "string" && (WORKPLACES as readonly string[]).includes(value);
}

/**
 * How a role reads in the meta line: "Remote", "Hybrid · Austin, TX",
 * "Austin, TX". On-site with a location doesn't need the word "on-site" —
 * a bare city already says it.
 */
export function workplaceSummary(
  workplace: Workplace,
  location: string | null | undefined,
): string | null {
  const place = location?.trim() || null;
  if (workplace === "remote") return place ? `Remote · ${place}` : "Remote";
  if (workplace === "hybrid") return place ? `Hybrid · ${place}` : "Hybrid";
  return place ?? "On-site";
}

// schema.org employmentType wants these tokens, not our display labels.
const SCHEMA_EMPLOYMENT_TYPE: Record<string, string> = {
  "Full-time": "FULL_TIME",
  "Part-time": "PART_TIME",
  Contract: "CONTRACTOR",
  Internship: "INTERN",
  Temporary: "TEMPORARY",
};

/** Map a display label to the schema.org employmentType token, if we know it. */
export function schemaEmploymentType(label: string | null | undefined): string | null {
  if (!label) return null;
  return SCHEMA_EMPLOYMENT_TYPE[label] ?? null;
}

export interface PublicJob {
  id: string;
  slug: string;
  title: string;
  department: string | null;
  location: string | null;
  employment_type: string;
  workplace: Workplace;
  compensation: string | null;
  apply_url: string | null;
  overview: string | null;
  responsibilities: string[];
  qualifications: string[];
  published_at: string | null;
}

const MAX_SLUG = 60;

/**
 * URL-safe slug for a job title. Deliberately ASCII-only: the slug lands in a
 * public URL and in the widget's DOM ids, so exotic characters buy nothing.
 */
export function slugifyTitle(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return base || "role";
}

/**
 * Pick a slug that does not collide with `taken`, appending -2, -3, … The
 * caller passes the slugs already used by the same project.
 */
export function uniqueSlug(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugifyTitle(title);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Split a textarea into a clean list. Accepts newline-separated lines with or
 * without leading bullets — the dashboard form is a textarea, not a list
 * builder, so people paste from docs and we tidy up.
 */
export function parseLines(input: string | null | undefined, max = 40): string[] {
  if (!input) return [];
  return input
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*\u2022\u00b7]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Loose email check — the real validation is that we can deliver to it. */
export function isValidEmail(value: string): boolean {
  if (value.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());
}

/**
 * Applicants paste "github.com/foo" as often as a full URL. Accept both, but
 * only ever store http(s) — this string is rendered as a link in the
 * dashboard, so a `javascript:` payload must never survive.
 */
export function normalizeLink(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname.includes(".")) return null;
  return url.toString().slice(0, 500);
}

/** Canonical, crawlable URL for a posting on crawlproof.com. */
export function hostedJobUrl(siteUrl: string, projectId: string, slug: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/c/${projectId}/${slug}`;
}

/**
 * schema.org JobPosting for one role. This is the payload that makes the
 * widget legible to Google for Jobs and to LLM crawlers — without it a
 * client-rendered board is invisible, which is the exact failure CrawlProof
 * audits for.
 */
export function jobPostingJsonLd(input: {
  job: PublicJob;
  siteUrl: string;
  projectId: string;
  projectName: string;
  projectUrl: string;
  pageUrl?: string;
}): Record<string, unknown> {
  const { job, siteUrl, projectId, projectName, projectUrl } = input;
  const description =
    [
      job.overview,
      job.responsibilities.length
        ? `Key Responsibilities: ${job.responsibilities.join("; ")}`
        : null,
      job.qualifications.length
        ? `Minimum Qualifications: ${job.qualifications.join("; ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n") || job.title;

  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description,
    identifier: {
      "@type": "PropertyValue",
      name: projectName,
      value: job.slug,
    },
    datePosted: job.published_at ?? undefined,
    employmentType: SCHEMA_EMPLOYMENT_TYPE[job.employment_type] ?? undefined,
    hiringOrganization: {
      "@type": "Organization",
      name: projectName,
      sameAs: projectUrl,
    },
    directApply: !job.apply_url,
    url: input.pageUrl ?? hostedJobUrl(siteUrl, projectId, job.slug),
  };

  // Google's JobPosting rules: fully remote roles use jobLocationType with
  // applicantLocationRequirements and no jobLocation; hybrid carries both the
  // physical address and TELECOMMUTE; on-site is a plain jobLocation.
  const place = job.location
    ? {
        "@type": "Place",
        address: { "@type": "PostalAddress", addressLocality: job.location },
      }
    : null;

  if (job.workplace === "remote") {
    node.jobLocationType = "TELECOMMUTE";
    if (job.location) {
      node.applicantLocationRequirements = { "@type": "Country", name: job.location };
    }
  } else if (job.workplace === "hybrid") {
    node.jobLocationType = "TELECOMMUTE";
    if (place) node.jobLocation = place;
  } else if (place) {
    node.jobLocation = place;
  }
  if (job.department) node.occupationalCategory = job.department;

  // Strip undefined so the emitted JSON stays tight.
  return Object.fromEntries(Object.entries(node).filter(([, v]) => v !== undefined));
}
