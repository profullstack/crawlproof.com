import { describe, it, expect } from "vitest";
import {
  isValidEmail,
  jobPostingJsonLd,
  normalizeLink,
  parseLines,
  schemaEmploymentType,
  slugifyTitle,
  uniqueSlug,
  workplaceSummary,
  type PublicJob,
} from "@/lib/careers/jobs";

describe("slugifyTitle", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyTitle("Senior HPC Engineer")).toBe("senior-hpc-engineer");
  });

  it("strips accents and punctuation rather than encoding them", () => {
    expect(slugifyTitle("Ingénieur Systèmes (H/F)")).toBe("ingenieur-systemes-h-f");
  });

  it("never returns an empty slug", () => {
    expect(slugifyTitle("***")).toBe("role");
    expect(slugifyTitle("")).toBe("role");
  });

  it("does not leave a trailing hyphen after truncating", () => {
    const slug = slugifyTitle("a".repeat(58) + " bbbb");
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(60);
  });
});

describe("uniqueSlug", () => {
  it("returns the base slug when free", () => {
    expect(uniqueSlug("Staff Engineer", [])).toBe("staff-engineer");
  });

  it("suffixes on collision", () => {
    expect(uniqueSlug("Staff Engineer", ["staff-engineer"])).toBe("staff-engineer-2");
    expect(uniqueSlug("Staff Engineer", ["staff-engineer", "staff-engineer-2"])).toBe(
      "staff-engineer-3",
    );
  });
});

describe("parseLines", () => {
  it("splits lines and strips bullet characters", () => {
    expect(parseLines("- One\n* Two\n• Three\n\nFour")).toEqual([
      "One",
      "Two",
      "Three",
      "Four",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseLines("")).toEqual([]);
    expect(parseLines(null)).toEqual([]);
    expect(parseLines("   \n  \n")).toEqual([]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 60 }, (_, i) => `item ${i}`).join("\n");
    expect(parseLines(many)).toHaveLength(40);
  });
});

describe("isValidEmail", () => {
  it("accepts ordinary addresses", () => {
    expect(isValidEmail("jane@example.com")).toBe(true);
    expect(isValidEmail("jane.doe+tag@sub.example.co.uk")).toBe(true);
  });

  it("rejects malformed ones", () => {
    for (const bad of ["jane", "jane@", "@example.com", "jane@example", "a b@c.com"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });
});

describe("normalizeLink", () => {
  it("adds a scheme when the applicant omits it", () => {
    expect(normalizeLink("github.com/jane")).toBe("https://github.com/jane");
  });

  it("keeps an explicit scheme", () => {
    expect(normalizeLink("http://example.com/cv")).toBe("http://example.com/cv");
  });

  // The dashboard renders this value as an href, so a script URL must never
  // survive normalization.
  it("rejects non-http schemes", () => {
    expect(normalizeLink("javascript:alert(1)")).toBe(null);
    expect(normalizeLink("data:text/html,<script>")).toBe(null);
  });

  it("rejects hostnames that aren't hostnames", () => {
    expect(normalizeLink("not a url")).toBe(null);
    expect(normalizeLink("localhost")).toBe(null);
  });

  it("treats blank input as absent", () => {
    expect(normalizeLink("")).toBe(null);
    expect(normalizeLink("   ")).toBe(null);
    expect(normalizeLink(undefined)).toBe(null);
  });
});

describe("workplaceSummary", () => {
  it("labels remote and hybrid, but lets a bare city speak for on-site", () => {
    expect(workplaceSummary("remote", null)).toBe("Remote");
    expect(workplaceSummary("remote", "US")).toBe("Remote · US");
    expect(workplaceSummary("hybrid", "Austin, TX")).toBe("Hybrid · Austin, TX");
    expect(workplaceSummary("onsite", "Austin, TX")).toBe("Austin, TX");
    expect(workplaceSummary("onsite", null)).toBe("On-site");
  });
});

describe("schemaEmploymentType", () => {
  it("maps display labels to schema.org tokens", () => {
    expect(schemaEmploymentType("Full-time")).toBe("FULL_TIME");
    expect(schemaEmploymentType("Contract")).toBe("CONTRACTOR");
  });

  it("returns null for anything it doesn't know", () => {
    expect(schemaEmploymentType("Seasonal")).toBe(null);
    expect(schemaEmploymentType(null)).toBe(null);
  });
});

describe("jobPostingJsonLd", () => {
  const base: PublicJob = {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "hpc-engineer",
    title: "HPC Engineer",
    department: "Engineering",
    location: "Austin, TX",
    employment_type: "Full-time",
    workplace: "onsite",
    compensation: null,
    apply_url: null,
    overview: "Build the cluster.",
    responsibilities: ["Tune RDMA fabric"],
    qualifications: ["5y Linux"],
    published_at: "2026-08-01T00:00:00.000Z",
  };

  const ctx = {
    siteUrl: "https://crawlproof.com",
    projectId: "22222222-2222-2222-2222-222222222222",
    projectName: "Acme",
    projectUrl: "https://acme.test",
  };

  it("emits a JobPosting pointing at the hosted canonical URL", () => {
    const node = jobPostingJsonLd({ job: base, ...ctx });
    expect(node["@type"]).toBe("JobPosting");
    expect(node.title).toBe("HPC Engineer");
    expect(node.url).toBe(
      "https://crawlproof.com/c/22222222-2222-2222-2222-222222222222/hpc-engineer",
    );
    expect(node.datePosted).toBe("2026-08-01T00:00:00.000Z");
    expect(node.employmentType).toBe("FULL_TIME");
  });

  it("folds responsibilities and qualifications into the description", () => {
    const node = jobPostingJsonLd({ job: base, ...ctx });
    expect(node.description).toContain("Build the cluster.");
    expect(node.description).toContain("Key Responsibilities: Tune RDMA fabric");
    expect(node.description).toContain("Minimum Qualifications: 5y Linux");
  });

  // Google's rules differ per workplace, and getting these wrong is the
  // difference between appearing in Google for Jobs and not.
  it("uses jobLocation alone for on-site roles", () => {
    const node = jobPostingJsonLd({ job: base, ...ctx });
    expect(node.jobLocation).toBeTruthy();
    expect(node.jobLocationType).toBeUndefined();
  });

  it("uses TELECOMMUTE without a jobLocation for remote roles", () => {
    const node = jobPostingJsonLd({ job: { ...base, workplace: "remote" }, ...ctx });
    expect(node.jobLocationType).toBe("TELECOMMUTE");
    expect(node.jobLocation).toBeUndefined();
    expect(node.applicantLocationRequirements).toEqual({
      "@type": "Country",
      name: "Austin, TX",
    });
  });

  it("carries both for hybrid roles", () => {
    const node = jobPostingJsonLd({ job: { ...base, workplace: "hybrid" }, ...ctx });
    expect(node.jobLocationType).toBe("TELECOMMUTE");
    expect(node.jobLocation).toBeTruthy();
  });

  it("marks directApply false when the role links out", () => {
    const node = jobPostingJsonLd({
      job: { ...base, apply_url: "https://boards.example.com/1" },
      ...ctx,
    });
    expect(node.directApply).toBe(false);
  });

  it("drops undefined keys instead of emitting nulls", () => {
    const node = jobPostingJsonLd({
      job: { ...base, published_at: null, employment_type: "Seasonal" },
      ...ctx,
    });
    expect(Object.keys(node)).not.toContain("datePosted");
    expect(Object.keys(node)).not.toContain("employmentType");
  });

  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(jobPostingJsonLd({ job: base, ...ctx }))).not.toThrow();
  });
});
