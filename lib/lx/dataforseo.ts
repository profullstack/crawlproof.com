// Thin DataForSEO Google Ads client.
// PRD §15. Spec verified against live API on 2026-05-13.
//
// All three methods return the same row shape, so the caller can treat
// them uniformly. The class itself stays stateless beyond credentials;
// it's safe to instantiate per call.

export type DfsKeywordRow = {
  keyword: string;
  search_volume: number | null;
  competition: "LOW" | "MEDIUM" | "HIGH" | null;
  competition_index: number | null;
  cpc: number | null;
  low_top_of_page_bid: number | null;
  high_top_of_page_bid: number | null;
  monthly_searches: Array<{ year: number; month: number; search_volume: number }> | null;
};

export type DfsResult = {
  rows: DfsKeywordRow[];
  cost: number;
  taskId: string | null;
};

const BASE = "https://api.dataforseo.com";

function basicAuth(login: string, password: string): string {
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

function normalizeRow(raw: any): DfsKeywordRow {
  return {
    keyword: String(raw.keyword ?? "").trim(),
    search_volume: typeof raw.search_volume === "number" ? raw.search_volume : null,
    competition: raw.competition ?? null,
    competition_index:
      typeof raw.competition_index === "number" ? raw.competition_index : null,
    cpc: typeof raw.cpc === "number" ? raw.cpc : null,
    low_top_of_page_bid:
      typeof raw.low_top_of_page_bid === "number" ? raw.low_top_of_page_bid : null,
    high_top_of_page_bid:
      typeof raw.high_top_of_page_bid === "number" ? raw.high_top_of_page_bid : null,
    monthly_searches: Array.isArray(raw.monthly_searches) ? raw.monthly_searches : null,
  };
}

export class DataForSeoClient {
  constructor(
    private login: string,
    private password: string,
  ) {}

  private async post(path: string, body: unknown): Promise<DfsResult> {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basicAuth(this.login, this.password),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`DataForSEO ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    if (json.status_code !== 20000) {
      throw new Error(`DataForSEO status ${json.status_code}: ${json.status_message}`);
    }
    const task = json.tasks?.[0];
    if (!task || task.status_code !== 20000) {
      throw new Error(
        `DataForSEO task error ${task?.status_code}: ${task?.status_message ?? "unknown"}`,
      );
    }
    const rows: DfsKeywordRow[] = Array.isArray(task.result)
      ? task.result.map(normalizeRow)
      : [];
    return {
      rows,
      cost: typeof json.cost === "number" ? json.cost : 0,
      taskId: task.id ?? null,
    };
  }

  // PRD §15.2a: idea expansion from seed.
  async keywordsForKeywords(seeds: string[], opts?: {
    locationCode?: number;
    languageCode?: string;
    sortBy?: "relevance" | "search_volume";
  }): Promise<DfsResult> {
    const payload: any = {
      keywords: seeds.slice(0, 20),
      sort_by: opts?.sortBy ?? "relevance",
    };
    if (opts?.locationCode) payload.location_code = opts.locationCode;
    if (opts?.languageCode) payload.language_code = opts.languageCode;
    return this.post("/v3/keywords_data/google_ads/keywords_for_keywords/live", [payload]);
  }

  // PRD §15.2a: volume lookup for a known list (no fan-out).
  async searchVolume(keywords: string[], opts?: {
    locationCode?: number;
    languageCode?: string;
  }): Promise<DfsResult> {
    const payload: any = { keywords: keywords.slice(0, 1000) };
    if (opts?.locationCode) payload.location_code = opts.locationCode;
    if (opts?.languageCode) payload.language_code = opts.languageCode;
    return this.post("/v3/keywords_data/google_ads/search_volume/live", [payload]);
  }

  // Competitor mining.
  async keywordsForSite(target: string, opts?: {
    locationCode?: number;
    languageCode?: string;
  }): Promise<DfsResult> {
    const payload: any = { target };
    if (opts?.locationCode) payload.location_code = opts.locationCode;
    if (opts?.languageCode) payload.language_code = opts.languageCode;
    return this.post("/v3/keywords_data/google_ads/keywords_for_site/live", [payload]);
  }
}

// PRD §15.1a outlier filter. DataForSEO occasionally returns junk rows
// with implausibly high volume + low competition.
export function filterOutliers(rows: DfsKeywordRow[]): DfsKeywordRow[] {
  return rows.filter((r) => {
    const vol = r.search_volume ?? 0;
    const ci = r.competition_index ?? 0;
    const cpc = r.cpc ?? 0;
    if (ci <= 2 && vol > 100_000) return false;
    if (cpc > 0 && cpc < 0.5 && vol > 50_000) return false;
    if (r.keyword.length > 80) return false;
    if (/https?:\/\//i.test(r.keyword)) return false;
    return true;
  });
}
