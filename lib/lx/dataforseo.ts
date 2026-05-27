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

function dataForSeoErrorMessage(
  status: number,
  text: string,
): string {
  try {
    const json = JSON.parse(text);
    const task = Array.isArray(json.tasks) ? json.tasks[0] : null;
    const taskCode =
      typeof task?.status_code === "number" ? ` task ${task.status_code}` : "";
    const taskMessage =
      typeof task?.status_message === "string" && task.status_message.trim()
        ? task.status_message.trim()
        : null;
    const topMessage =
      typeof json.status_message === "string" && json.status_message.trim()
        ? json.status_message.trim()
        : null;
    const message = taskMessage ?? topMessage ?? "request failed";
    return `DataForSEO HTTP ${status}${taskCode}: ${message}`;
  } catch {
    return `DataForSEO HTTP ${status}: ${text.slice(0, 300) || "request failed"}`;
  }
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
      throw new Error(dataForSeoErrorMessage(res.status, text));
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

  // PRD §15.2a: volume lookup for a known list (no fan-out). The
  // Google Ads search_volume endpoint requires a location — unlike
  // some other Google Ads endpoints that default to worldwide. We
  // default to 2840 (US) / "en" so the form works without an explicit
  // setting; callers can override per-call.
  async searchVolume(keywords: string[], opts?: {
    locationCode?: number;
    languageCode?: string;
  }): Promise<DfsResult> {
    const payload: any = {
      keywords: keywords.slice(0, 1000),
      location_code: opts?.locationCode ?? 2840,
      language_code: opts?.languageCode ?? "en",
    };
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

  // DataForSEO Labs "Keyword Ideas" — category-based expansion. Accepts
  // up to 200 seeds and returns up to 1000 ideas with search_volume,
  // CPC, competition, and a keyword_properties object that includes
  // keyword_difficulty + word_count. Server-side `filters` let us push
  // word-count and volume filtering to the API so we don't pay for
  // rows we'll discard.
  async keywordIdeas(seeds: string[], opts?: {
    locationCode?: number;
    languageCode?: string;
    closelyVariants?: boolean;
    minVolume?: number;
    minWords?: number;
    limit?: number;
  }): Promise<DfsResult> {
    // Labs endpoints require a location (unlike Google Ads
    // keywords_for_keywords where it defaults to worldwide). The API's
    // error in this case is misleading — it complains about an
    // "Invalid Field: 'location_name'" when neither field is sent.
    // 2840 = United States, "en" = English.
    const payload: any = {
      keywords: seeds.slice(0, 200),
      location_code: opts?.locationCode ?? 2840,
      language_code: opts?.languageCode ?? "en",
      closely_variants: opts?.closelyVariants ?? false,
      limit: Math.min(opts?.limit ?? 100, 1000),
      // DataForSEO Labs filters use [field, op, value] triples joined
      // by "and"/"or" strings. Each filter compresses what would
      // otherwise be a client-side filter pass.
      filters: [
        ["keyword_info.search_volume", ">=", opts?.minVolume ?? 100],
        "and",
        ["keyword_properties.keyword_difficulty", "<=", 80],
      ],
      order_by: ["keyword_info.search_volume,desc"],
    };
    return this.postLabs("/v3/dataforseo_labs/google/keyword_ideas/live", [payload], opts?.minWords);
  }

  // Labs endpoints return a different shape than Google Ads endpoints
  // (rows live under `result[0].items[]` and the keyword fields nest
  // inside `keyword_info`). We re-pack them into the same DfsKeywordRow
  // so callers don't care which API surface produced them.
  private async postLabs(
    path: string,
    body: unknown,
    minWords?: number,
  ): Promise<DfsResult> {
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
      throw new Error(dataForSeoErrorMessage(res.status, text));
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
    const items: any[] = task.result?.[0]?.items ?? [];
    const rows: DfsKeywordRow[] = items
      .map((it) => {
        const ki = it?.keyword_info ?? {};
        return {
          keyword: String(it.keyword ?? "").trim(),
          search_volume: typeof ki.search_volume === "number" ? ki.search_volume : null,
          competition: ki.competition_level ?? null,
          competition_index: typeof ki.competition_index === "number" ? ki.competition_index : null,
          cpc: typeof ki.cpc === "number" ? ki.cpc : null,
          low_top_of_page_bid:
            typeof ki.low_top_of_page_bid === "number" ? ki.low_top_of_page_bid : null,
          high_top_of_page_bid:
            typeof ki.high_top_of_page_bid === "number" ? ki.high_top_of_page_bid : null,
          monthly_searches: Array.isArray(ki.monthly_searches) ? ki.monthly_searches : null,
        };
      })
      .filter((r) => {
        if (!r.keyword) return false;
        if (minWords && r.keyword.split(/\s+/).length < minWords) return false;
        return true;
      });
    return {
      rows,
      cost: typeof json.cost === "number" ? json.cost : 0,
      taskId: task.id ?? null,
    };
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
