import { describe, it, expect } from "vitest";
import {
  analyzePage,
  analyzeSite,
  buildSlopReport,
  slopFindings,
  slopGrade,
  slopMarkdown,
  toSlopPage,
} from "@/lib/audit/checks/slop";

function page(html: string, url = "https://example.com/") {
  return toSlopPage({ url, status: 200, html });
}

/** ~200 words of specific, evidence-bearing prose — the "clean" baseline. */
const GOOD_BODY = `
<h1>Ship faster with staged rollouts</h1>
<p>We cut deploy time at Northwind Logistics from 42 minutes to 6 minutes by batching
migrations. Their team ships 30 times a week now, up from 4.</p>
<blockquote>"Deploys stopped being a meeting." — Dana Ruiz, VP Engineering, Northwind</blockquote>
<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Team</td><td>$49</td></tr></table>
<pre><code>npx shipctl rollout --staged</code></pre>
<img src="/screens/rollout.png" alt="Rollout dashboard showing a 6 minute deploy" width="800" height="400" />
<p>Rollouts pause automatically when error rates exceed 2% over a 5 minute window.
That threshold is configurable per service. We measured a 71% drop in rollbacks across
the 340 teams using staged rollouts in 2026, and published the raw data.</p>
<p>Every plan includes audit logs, SSO, and 90 days of deploy history. Support responds
in under 3 hours on weekdays. There is no per-seat charge for read-only accounts, so
reviewers and auditors cost nothing to add.</p>
<p>Migration takes about 20 minutes for a typical monorepo. We provide a codemod that
rewrites your existing pipeline config, and the CLI validates it before the first run.</p>
`;

const CLEAN_HTML = `<!doctype html><html lang="en"><head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Staged rollouts — Shipctl</title>
<meta name="description" content="Cut deploy time with staged rollouts." />
</head><body>${GOOD_BODY}</body></html>`;

describe("slop: clean page", () => {
  it("finds no issues on a well-built, evidence-rich page", () => {
    const r = analyzePage(page(CLEAN_HTML));
    expect(r.issues).toEqual([]);
    expect(r.points).toBe(0);
  });

  it("scores a clean single-page site as Pristine", () => {
    const report = buildSlopReport([page(CLEAN_HTML)]);
    expect(report.score).toBe(0);
    expect(report.grade).toBe("Pristine");
  });
});

describe("slop: content detectors", () => {
  it("flags lorem ipsum and coming-soon placeholders", () => {
    const r = analyzePage(page(`<body><h1>Hi</h1><p>Lorem ipsum dolor sit amet, coming soon!</p></body>`));
    const issue = r.issues.find((i) => i.key === "content.placeholder");
    expect(issue).toBeDefined();
    expect(issue!.samples).toContain("Lorem ipsum filler text");
    expect(issue!.dimension).toBe("content");
  });

  // Regression guards from the dogfood run against crawlproof.com's own blog,
  // where both of these read as placeholders but were legitimate prose.
  it("does not flag placeholder phrases used mid-sentence in real prose", () => {
    const prose = analyzePage(
      page(
        `<body><h1>Freshness conflicts</h1>
        <p>If your old comparison page says a feature is coming soon, while your product page says it
        launched last year, you have a freshness conflict. Success is not just seeing your brand name
        in an AI answer — that can happen for the wrong reason. ${"We measured a 14% lift across 90 accounts. ".repeat(20)}</p>
        <blockquote>"It worked." — Dana Ruiz, Northwind</blockquote></body>`,
      ),
    );
    expect(prose.issues.some((i) => i.key === "content.placeholder")).toBe(false);
  });

  it("still flags placeholder phrases that stand alone as an element's whole text", () => {
    const standalone = analyzePage(page(`<body><h1>Our pricing</h1><p>Coming soon</p></body>`));
    const issue = standalone.issues.find((i) => i.key === "content.placeholder");
    expect(issue).toBeDefined();
    expect(issue!.samples).toContain('"Coming soon" placeholder');
  });

  it("exempts listing pages from prose-quality checks", () => {
    const links = Array.from({ length: 20 }, (_, i) => `<a href="/post-${i}">Post ${i} about deploys</a>`).join("");
    const index = analyzePage(page(`<body><h1>Blog</h1>${links}</body>`, "https://example.com/blog"));
    expect(index.issues.some((i) => i.key === "content.no_first_party_evidence")).toBe(false);
    expect(index.issues.some((i) => i.key === "content.thin")).toBe(false);
  });

  it("flags filler-phrase density but not a single incidental phrase", () => {
    const filler = Array.from({ length: 6 }, () =>
      "In today's fast-paced world it is worth noting that we delve into the digital landscape to unlock the potential of your business.",
    ).join(" ");
    const many = analyzePage(page(`<body><p>${filler}</p></body>`));
    expect(many.issues.some((i) => i.key === "content.filler")).toBe(true);

    // One or two stock phrases in a page of real content is ordinary writing —
    // it must stay under the absolute floor, or we'd flag good pages.
    const padding = "We measured a 12% drop in latency across 40 services. ".repeat(30);
    const one = analyzePage(page(`<body><p>At the end of the day. ${padding}</p></body>`));
    expect(one.issues.some((i) => i.key === "content.filler")).toBe(false);

    const two = analyzePage(page(`<body><p>At the end of the day. When it comes to this. ${padding}</p></body>`));
    expect(two.issues.some((i) => i.key === "content.filler")).toBe(false);
  });

  it("flags a page with no first-party evidence", () => {
    const vague = "Our platform helps teams work better together with modern tooling. ".repeat(24);
    const r = analyzePage(page(`<body><h1>Platform</h1><p>${vague}</p></body>`));
    expect(r.issues.some((i) => i.key === "content.no_first_party_evidence")).toBe(true);
  });

  it("does not flag evidence when stats and quotes are present", () => {
    const r = analyzePage(page(CLEAN_HTML));
    expect(r.issues.some((i) => i.key === "content.no_first_party_evidence")).toBe(false);
  });

  it("flags thin pages", () => {
    const r = analyzePage(page(`<body><h1>Contact</h1><p>Email us.</p></body>`));
    const thin = r.issues.find((i) => i.key === "content.thin");
    expect(thin).toBeDefined();
    expect(thin!.count).toBeLessThan(150);
  });

  it("flags a stale copyright but accepts the current and previous year", () => {
    const year = new Date().getUTCFullYear();
    const stale = analyzePage(page(`<body><footer>© 2019 Acme</footer></body>`));
    expect(stale.issues.some((i) => i.key === "content.stale_copyright")).toBe(true);

    const fresh = analyzePage(page(`<body><footer>© ${year} Acme</footer></body>`));
    expect(fresh.issues.some((i) => i.key === "content.stale_copyright")).toBe(false);

    const lastYear = analyzePage(page(`<body><footer>© ${year - 1} Acme</footer></body>`));
    expect(lastYear.issues.some((i) => i.key === "content.stale_copyright")).toBe(false);
  });

  it("flags high-confidence misspellings only", () => {
    const bad = analyzePage(page(`<body><p>We recieve seperate payments and definately accomodate you.</p></body>`));
    const m = bad.issues.find((i) => i.key === "content.misspelling");
    expect(m).toBeDefined();
    expect(m!.count).toBe(4);

    // Product names and unusual-but-correct words must never be flagged.
    const ok = analyzePage(page(`<body><p>Shipctl Kubernetes Grafana Turso libSQL Anthropic queueing</p></body>`));
    expect(ok.issues.some((i) => i.key === "content.misspelling")).toBe(false);
  });
});

describe("slop: code detectors", () => {
  it("flags unrendered template variables and JS accidents", () => {
    const r = analyzePage(
      page(`<body><h1>Hello {{ user.firstName }}</h1><p>Total: [object Object] — undefined items</p></body>`),
    );
    const leaked = r.issues.filter((i) => i.key === "code.leaked_value");
    expect(leaked.length).toBeGreaterThanOrEqual(3);
    expect(leaked.some((i) => i.label.includes("{{template}}"))).toBe(true);
    expect(leaked.some((i) => i.label.includes("[object Object]"))).toBe(true);
  });

  it("flags dev/staging hosts in production markup", () => {
    const r = analyzePage(
      page(`<body><a href="http://localhost:3000/admin">Admin</a><img src="https://my-app.vercel.app/x.png"></body>`),
    );
    const issue = r.issues.find((i) => i.key === "code.dev_artifact_host");
    expect(issue).toBeDefined();
    expect(issue!.count).toBeGreaterThanOrEqual(2);
  });

  // All three of these were false positives found by dogfooding on real sites.
  it("does not flag a preview host in an outbound link", () => {
    // A link aggregator linking someone's Vercel demo is content, not a leak.
    const r = analyzePage(
      page(`<body><a href="https://aetherfall-ten.vercel.app">Show HN: my project</a></body>`, "https://news.example.com/show"),
    );
    expect(r.issues.some((i) => i.key === "code.dev_artifact_host")).toBe(false);
  });

  it("does not flag a hostname that only appears in body text or JSON-LD", () => {
    const r = analyzePage(
      page(
        `<body><div>AEO audit for devdrafts.netlify.app</div>
        <script type="application/ld+json">{"name":"AEO audit for devdrafts.netlify.app"}</script></body>`,
      ),
    );
    expect(r.issues.some((i) => i.key === "code.dev_artifact_host")).toBe(false);
  });

  it("still flags a preview host that a resource is loaded from", () => {
    const r = analyzePage(page(`<body><script src="https://my-app.vercel.app/widget.js"></script></body>`));
    expect(r.issues.some((i) => i.key === "code.dev_artifact_host")).toBe(true);
  });

  it("does not flag the site's own host as a dev artifact", () => {
    const r = analyzePage(
      page(`<body><a href="https://my-app.vercel.app/about">About</a></body>`, "https://my-app.vercel.app/"),
    );
    expect(r.issues.some((i) => i.key === "code.dev_artifact_host")).toBe(false);
  });

  it("flags console calls and TODO comments left in markup", () => {
    const r = analyzePage(
      page(`<body><!-- TODO: fix the nav before launch --><script>console.log("here")</script></body>`),
    );
    expect(r.issues.some((i) => i.key === "code.console_left_in")).toBe(true);
    expect(r.issues.some((i) => i.key === "code.todo_comment")).toBe(true);
  });

  it("flags placeholder hrefs and unlabelled links", () => {
    const r = analyzePage(
      page(`<body><a href="#">a</a><a href="#">b</a><a href="javascript:void(0)">c</a><a href="/x"></a></body>`),
    );
    expect(r.issues.some((i) => i.key === "code.dead_links")).toBe(true);
  });

  it("flags deprecated tags", () => {
    const r = analyzePage(page(`<body><center><font size="2">Welcome</font></center></body>`));
    const issue = r.issues.find((i) => i.key === "code.deprecated_tags");
    expect(issue).toBeDefined();
    expect(issue!.label).toContain("<center>");
  });
});

describe("slop: design detectors", () => {
  it("flags a missing viewport meta", () => {
    const r = analyzePage(page(`<html><head><title>T</title></head><body><p>Hi</p></body></html>`));
    expect(r.issues.some((i) => i.key === "design.no_viewport")).toBe(true);
  });

  it("flags placeholder alt text but accepts descriptive alt", () => {
    const bad = analyzePage(page(`<body><img src="/a.png" alt="image"><img src="/b.png" alt="DSC_0042"></body>`));
    expect(bad.issues.some((i) => i.key === "design.placeholder_alt")).toBe(true);

    const good = analyzePage(page(`<body><img src="/a.png" alt="Deploy pipeline with three staged rollouts"></body>`));
    expect(good.issues.some((i) => i.key === "design.placeholder_alt")).toBe(false);
  });

  it("flags unsized images that cause layout shift", () => {
    const imgs = Array.from({ length: 5 }, (_, i) => `<img src="/i${i}.png" alt="Chart ${i} of deploy times">`).join("");
    const r = analyzePage(page(`<body>${imgs}</body>`));
    expect(r.issues.some((i) => i.key === "design.unsized_images")).toBe(true);
  });

  it("flags stock-only imagery", () => {
    const r = analyzePage(
      page(
        `<body><img src="https://images.unsplash.com/a" alt="Team collaborating at a desk"><img src="https://images.pexels.com/b" alt="Laptop on a table"></body>`,
      ),
    );
    expect(r.issues.some((i) => i.key === "design.stock_only_imagery")).toBe(true);
  });

  it("flags palette, font and !important sprawl in stylesheets", () => {
    const hexes = Array.from({ length: 80 }, (_, i) => `.c${i}{color:#${(0x111111 + i * 7).toString(16).padStart(6, "0")}}`).join("");
    const fonts = ["Inter", "Roboto", "Lato", "Georgia", "Courier", "Arial", "Verdana"]
      .map((f, i) => `.f${i}{font-family:"${f}",sans-serif}`)
      .join("");
    const importants = Array.from({ length: 30 }, (_, i) => `.i${i}{margin:0 !important}`).join("");
    const issues = analyzeSite([page(CLEAN_HTML)], [{ url: "https://example.com/a.css", css: hexes + fonts + importants }]);
    expect(issues.some((i) => i.key === "design.palette_sprawl")).toBe(true);

    // A design system that DEFINES a big ramp as custom properties is the
    // opposite of sprawl — Tailwind emits ~100 steps — so token definitions
    // must not count against it.
    const tokens = `:root{${Array.from({ length: 90 }, (_, i) => `--color-x${i}:#${(0x222222 + i * 11).toString(16).padStart(6, "0")};`).join("")}}
      .btn{color:var(--color-x1);background:var(--color-x2)}`;
    const tokenIssues = analyzeSite([page(CLEAN_HTML)], [{ url: "https://example.com/t.css", css: tokens }]);
    expect(tokenIssues.some((i) => i.key === "design.palette_sprawl")).toBe(false);
    expect(issues.some((i) => i.key === "design.font_sprawl")).toBe(true);
    expect(issues.some((i) => i.key === "design.important_overuse")).toBe(true);
  });
});

describe("slop: cross-page detectors", () => {
  const dup = (n: number) =>
    page(
      `<html><head><meta name="viewport" content="width=device-width"><title>Best CRM Software</title>
      <meta name="description" content="The best CRM software for teams."></head>
      <body><h1>Best CRM</h1><p>${"Choosing the right CRM matters for your growing team because data drives revenue and revenue drives growth across every department. ".repeat(12)}</p></body></html>`,
      `https://example.com/p${n}`,
    );

  it("flags duplicate titles and descriptions", () => {
    const issues = analyzeSite([dup(1), dup(2), dup(3)]);
    expect(issues.some((i) => i.key === "code.duplicate_title")).toBe(true);
    expect(issues.some((i) => i.key === "code.duplicate_description")).toBe(true);
  });

  it("flags near-duplicate page bodies", () => {
    const issues = analyzeSite([dup(1), dup(2), dup(3)]);
    const near = issues.find((i) => i.key === "content.near_duplicate");
    expect(near).toBeDefined();
    expect(near!.count).toBe(3);
  });

  it("flags boilerplate intros repeated across pages", () => {
    const issues = analyzeSite([dup(1), dup(2), dup(3)]);
    expect(issues.some((i) => i.key === "content.boilerplate_intro")).toBe(true);
  });

  it("flags missing titles and h1s", () => {
    const bare = page(`<html><head></head><body><p>${"word ".repeat(100)}</p></body></html>`, "https://example.com/bare");
    const issues = analyzeSite([bare]);
    expect(issues.some((i) => i.key === "code.missing_title")).toBe(true);
    expect(issues.some((i) => i.key === "content.missing_h1")).toBe(true);
  });

  it("does not cross-flag genuinely distinct pages", () => {
    const a = page(CLEAN_HTML, "https://example.com/a");
    const b = page(
      `<html><head><meta name="viewport" content="width=device-width"><title>Pricing — Shipctl</title>
      <meta name="description" content="Plans start at $49 per team."></head>
      <body><h1>Pricing</h1><table><tr><td>Team</td><td>$49</td></tr></table>
      <p>${"Annual billing saves 18% and includes 90 days of deploy history for every service you register. ".repeat(10)}</p></body></html>`,
      "https://example.com/pricing",
    );
    const issues = analyzeSite([a, b]);
    expect(issues.some((i) => i.key === "content.near_duplicate")).toBe(false);
    expect(issues.some((i) => i.key === "code.duplicate_title")).toBe(false);
  });
});

describe("slop: scoring and output", () => {
  it("grades monotonically across the range", () => {
    expect(slopGrade(0)).toBe("Pristine");
    expect(slopGrade(20)).toBe("Clean");
    expect(slopGrade(40)).toBe("Some slop");
    expect(slopGrade(60)).toBe("Sloppy");
    expect(slopGrade(90)).toBe("Slop factory");
  });

  it("scores a sloppy site far above a clean one, and stays in range", () => {
    const clean = buildSlopReport([page(CLEAN_HTML)]);
    const sloppyHtml = `<body><h1>Hello {{name}}</h1><p>Lorem ipsum dolor sit amet. Coming soon. undefined</p>
      <center><font>old</font></center><a href="#">x</a><a href="#">y</a><a href="#">z</a>
      <img src="https://images.unsplash.com/a" alt="image"><script>console.log(1)</script>
      <footer>© 2018 Acme</footer></body>`;
    const sloppy = buildSlopReport([page(sloppyHtml)]);
    expect(sloppy.score).toBeGreaterThan(clean.score + 40);
    expect(sloppy.score).toBeLessThanOrEqual(100);
    expect(clean.score).toBeGreaterThanOrEqual(0);
  });

  it("emits a headline finding plus one finding per sloppy page", () => {
    const pages = [
      page(`<body><h1>A {{x}}</h1><p>Lorem ipsum dolor sit amet</p></body>`, "https://example.com/a"),
      page(`<body><h1>B</h1><p>Coming soon</p></body>`, "https://example.com/b"),
      page(CLEAN_HTML, "https://example.com/clean"),
    ];
    const report = buildSlopReport(pages);
    const findings = slopFindings(report);

    const headline = findings.find((f) => f.check_key === "slop.score");
    expect(headline).toBeDefined();
    expect(headline!.title).toMatch(/^Slop Score: \d+\/100 — /);
    expect(headline!.section).toBe("Slop Score");
    expect((headline!.evidence as { score: number }).score).toBe(report.score);

    // Per-page findings are keyed by path so each is independently fixable.
    expect(findings.some((f) => f.check_key === "slop.page.a")).toBe(true);
    expect(findings.some((f) => f.check_key === "slop.page.b")).toBe(true);
    expect(findings.some((f) => f.check_key === "slop.page.clean")).toBe(false);

    // Every page finding carries actionable fix text and machine-readable evidence.
    const pageFinding = findings.find((f) => f.check_key === "slop.page.a")!;
    expect(pageFinding.detail).toBeTruthy();
    const ev = pageFinding.evidence as { url: string; issues: Array<{ fix: string }> };
    expect(ev.url).toBe("https://example.com/a");
    expect(ev.issues.every((i) => i.fix.length > 0)).toBe(true);
  });

  it("rolls a defect repeated across many pages up into one template fix", () => {
    // Ten pages, each missing a viewport tag — a template bug, not ten bugs.
    const pages = Array.from({ length: 10 }, (_, i) =>
      page(`<html><head><title>P${i}</title></head><body><h1>P${i}</h1><p>${"Real content here. ".repeat(20)}</p></body></html>`, `https://example.com/p${i}`),
    );
    const findings = slopFindings(buildSlopReport(pages));
    const rollup = findings.find((f) => f.check_key === "slop.systemic.design.no_viewport");
    expect(rollup).toBeDefined();
    expect(rollup!.status).toBe("fail");
    expect(rollup!.title).toContain("10 pages share one defect");
    expect(rollup!.detail).toContain("shared template");
    expect((rollup!.evidence as { pages: number }).pages).toBe(10);

    // A defect on a single page must not be rolled up.
    expect(findings.some((f) => f.check_key.startsWith("slop.systemic.") && f.check_key.includes("misspelling"))).toBe(false);
  });

  it("caps per-page findings at the requested page limit", () => {
    const pages = Array.from({ length: 60 }, (_, i) =>
      page(`<body><h1>P${i}</h1><p>Lorem ipsum dolor sit amet</p></body>`, `https://example.com/p${i}`),
    );
    const findings = slopFindings(buildSlopReport(pages), 50);
    expect(findings.filter((f) => f.check_key.startsWith("slop.page.")).length).toBe(50);
  });

  it("renders markdown with the score, per-page table and fixes", () => {
    const report = buildSlopReport([page(`<body><h1>A</h1><p>Lorem ipsum dolor sit amet</p></body>`)]);
    const md = slopMarkdown({
      targetUrl: "https://example.com",
      report,
      crawled: 1,
      capped: false,
      durationMs: 1234,
      maxPages: 50,
    });
    expect(md).toContain("# Slop Score — https://example.com");
    expect(md).toContain(`## ${report.score}/100`);
    expect(md).toContain("Per-page findings");
    expect(md).toContain("does **not** estimate whether anything was written by AI");
  });

  it("never accuses a page of being AI-written, and says so explicitly", () => {
    const report = buildSlopReport([page(`<body><h1>A</h1><p>Lorem ipsum dolor sit amet</p></body>`)]);
    const findings = slopFindings(report);

    // No finding may claim authorship. Checked on titles and issue labels/fixes
    // — everything the reader is shown as a verdict.
    const verdicts = findings.flatMap((f) => {
      const ev = f.evidence as { issues?: Array<{ label: string; fix: string }> } | undefined;
      return [f.title, ...(ev?.issues?.flatMap((i) => [i.label, i.fix]) ?? [])];
    });
    for (const v of verdicts) {
      expect(v.toLowerCase()).not.toMatch(/ai[- ]generated|written by ai|ai probability|likely ai|ai content/);
    }

    // And the headline carries the disclaimer, so nobody reads the number as an
    // AI-detection result.
    const headline = findings.find((f) => f.check_key === "slop.score")!;
    expect(headline.detail).toContain("not whether anything was written by AI");
  });
});
