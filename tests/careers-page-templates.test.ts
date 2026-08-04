import { describe, expect, it } from "vitest";
import {
  careersRouteFiles,
  conflictingPaths,
  renderHelpers,
} from "@/lib/careers/page-templates";

// This module writes code into other people's repositories, so the tests do
// two things: check the file we produce is the right shape, and actually run
// the generated rendering logic against hostile input.

const INPUT = {
  origin: "https://crawlproof.com",
  projectId: "af9ab953-caa6-4a2b-a306-42fb4eac4630",
  dir: "app",
  typescript: true,
};

/** Execute the generated helpers so we can assert on real output. */
function runtime() {
  const factory = new Function(
    `${renderHelpers(false)}
    return { esc: esc, placeLabel: placeLabel, jobCard: jobCard, boardHtml: boardHtml };`,
  );
  return factory() as {
    esc: (v: unknown) => string;
    placeLabel: (job: Record<string, unknown>) => string;
    jobCard: (job: Record<string, unknown>) => string;
    boardHtml: (jobs: Record<string, unknown>[]) => string;
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    slug: "hpc-engineer",
    title: "HPC Engineer",
    department: "Infrastructure",
    location: "Austin, TX",
    employment_type: "Full-time",
    workplace: "onsite",
    compensation: "$180k–$220k",
    overview: "Own the cluster.",
    responsibilities: ["Keep it fast"],
    qualifications: ["Know Linux"],
    canonical_url: "https://crawlproof.com/c/proj/hpc-engineer",
    json_ld: { "@type": "JobPosting", title: "HPC Engineer" },
    ...overrides,
  };
}

describe("generated file shape", () => {
  it("writes a Next App Router page with a typed job shape", () => {
    const [file] = careersRouteFiles("next-app", INPUT);
    expect(file.path).toBe("app/careers/page.tsx");
    expect(file.content).toContain("type CareersJob");
    expect(file.content).toContain("export const revalidate = 300");
    expect(file.content).toContain("dangerouslySetInnerHTML");
    expect(file.content).toContain(
      "https://crawlproof.com/api/careers/jobs?site=af9ab953-caa6-4a2b-a306-42fb4eac4630",
    );
  });

  // Type annotations in a JavaScript repo would break their build outright.
  it("emits plain JavaScript, with no annotations, for a JS repo", () => {
    const [file] = careersRouteFiles("next-app", { ...INPUT, typescript: false });
    expect(file.path).toBe("app/careers/page.jsx");
    expect(file.content).not.toContain("type CareersJob");
    expect(file.content).not.toContain(": string");
    expect(file.content).not.toContain("Promise<");
  });

  it("honours a src/ layout", () => {
    const [file] = careersRouteFiles("next-app", { ...INPUT, dir: "src/app" });
    expect(file.path).toBe("src/app/careers/page.tsx");
  });

  it("writes an Astro page with frontmatter and set:html", () => {
    const [file] = careersRouteFiles("astro", { ...INPUT, dir: "src/pages" });
    expect(file.path).toBe("src/pages/careers.astro");
    expect(file.content.startsWith("---\n")).toBe(true);
    expect(file.content).toContain("set:html={html}");
    // Astro frontmatter is TypeScript, so the types stay regardless.
    expect(file.content).toContain("type CareersJob");
  });

  // A static Astro build bakes the roles in, and saying otherwise would have
  // people wondering why a new job never showed up.
  it("warns that a static Astro build only updates on deploy", () => {
    const [file] = careersRouteFiles("astro", { ...INPUT, dir: "src/pages" });
    expect(file.content).toContain("build time");
    expect(careersRouteFiles("next-app", INPUT)[0].content).not.toContain("build time");
  });

  it("marks the container so the widget replaces rather than duplicates", () => {
    for (const framework of ["next-app", "astro"] as const) {
      const [file] = careersRouteFiles(framework, INPUT);
      expect(file.content).toContain("data-cp-careers");
      expect(file.content).toContain("data-cp-careers-ssr");
    }
  });

  it("points the reader at the dashboard rather than the file", () => {
    const [file] = careersRouteFiles("next-app", INPUT);
    expect(file.content).toContain(
      "https://crawlproof.com/projects/af9ab953-caa6-4a2b-a306-42fb4eac4630/stats/careers",
    );
  });

  it("survives an origin with a trailing slash", () => {
    const [file] = careersRouteFiles("next-app", {
      ...INPUT,
      origin: "https://crawlproof.com/",
    });
    expect(file.content).toContain("https://crawlproof.com/api/careers/jobs?site=");
    expect(file.content).not.toContain("crawlproof.com//api");
  });

  it("never returns an empty file set", () => {
    for (const framework of ["next-app", "astro"] as const) {
      const files = careersRouteFiles(framework, INPUT);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect(f.content.length).toBeGreaterThan(0);
    }
  });
});

describe("conflictingPaths", () => {
  it("covers every extension a Next page could already use", () => {
    expect(conflictingPaths("next-app", "app")).toEqual([
      "app/careers/page.tsx",
      "app/careers/page.jsx",
      "app/careers/page.ts",
      "app/careers/page.js",
    ]);
  });

  it("covers both Astro spellings", () => {
    expect(conflictingPaths("astro", "src/pages")).toContain("src/pages/careers.astro");
    expect(conflictingPaths("astro", "src/pages")).toContain("src/pages/careers/index.astro");
  });
});

describe("generated rendering, executed", () => {
  it("escapes hostile job content instead of emitting it", () => {
    const { jobCard } = runtime();
    const html = jobCard(
      job({
        title: '<script>alert(1)</script>',
        overview: 'He said "hi" & left',
        location: "<img onerror=x>",
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;hi&quot;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<img onerror");
  });

  it("escapes the apply URL it puts in an href", () => {
    const { jobCard } = runtime();
    const html = jobCard(job({ canonical_url: 'https://x.test/"><script>' }));
    expect(html).not.toContain('"><script>');
  });

  it("labels remote and hybrid, but leaves a bare city alone", () => {
    const { placeLabel } = runtime();
    expect(placeLabel(job({ workplace: "remote", location: "" }))).toBe("Remote");
    expect(placeLabel(job({ workplace: "remote", location: "US" }))).toBe("Remote · US");
    expect(placeLabel(job({ workplace: "hybrid", location: "Austin" }))).toBe(
      "Hybrid · Austin",
    );
    expect(placeLabel(job({ workplace: "onsite", location: "Austin" }))).toBe("Austin");
    expect(placeLabel(job({ workplace: "onsite", location: "" }))).toBe("On-site");
  });

  it("renders the JobPosting graph into the markup", () => {
    const { boardHtml } = runtime();
    const html = boardHtml([job()]);
    expect(html).toContain('type="application/ld+json"');
    expect(html).toContain('"@type":"JobPosting"');
  });

  // A '<' inside the JSON payload would otherwise end the script element early
  // and spill the rest of the graph into the page as markup.
  it("neutralises < inside the JSON-LD payload", () => {
    const { boardHtml } = runtime();
    const html = boardHtml([
      job({ json_ld: { "@type": "JobPosting", title: "</script><img src=x>" } }),
    ]);
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c");
  });

  it("says so plainly when there are no open roles", () => {
    const { boardHtml } = runtime();
    expect(boardHtml([])).toContain("No open roles");
  });

  it("omits empty sections rather than printing bare headings", () => {
    const { jobCard } = runtime();
    const html = jobCard(job({ responsibilities: [], qualifications: [], overview: null }));
    expect(html).not.toContain("Responsibilities");
    expect(html).not.toContain("Qualifications");
    expect(html).toContain("HPC Engineer");
  });
});
