export type CheckStatus = "pass" | "warn" | "fail" | "unknown";

export type Finding = {
  section: string;
  check_key: string;
  status: CheckStatus;
  title: string;
  detail?: string;
  evidence?: Record<string, unknown>;
  priority: 1 | 2 | 3 | 4 | 5;
};

export type FetchedPage = {
  url: string;
  finalUrl: string;
  status: number;
  fetchedAt: string;
  contentType: string | null;
  headers: Record<string, string>;
  rawHtml: string;
  bytes: number;
  fetchMs: number;
  renderedText?: string;
  renderedHtml?: string;
  renderedBytes?: number;
  error?: string;
};

export type CrawlContext = {
  target: string;
  origin: string;
  host: string;
  pages: Record<string, FetchedPage>;
  wellKnown: {
    robots?: { content: string; status: number };
    sitemap?: { content: string; status: number };
    llmsTxt?: { content: string; status: number };
    llmsFullTxt?: { content: string; status: number };
    skillMd?: { content: string; status: number };
    aiPlugin?: { content: string; status: number };
    securityTxt?: { content: string; status: number };
  };
  findings: Finding[];
};

export type AuditResult = {
  score: number;
  findings: Finding[];
  summary: {
    pagesCrawled: number;
    pass: number;
    warn: number;
    fail: number;
    unknown: number;
    dataFound: Array<{
      dataPoint: string;
      found: boolean;
      source: string | null;
      notes: string | null;
    }>;
    durationMs: number;
  };
};
