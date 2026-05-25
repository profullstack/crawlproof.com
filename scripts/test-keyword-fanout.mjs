// Smoke-test per-seed keyword fan-out against DataForSEO Labs.
// Prints the top in-niche long-tails for threatcrush.com's seed list.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("/home/ubuntu/src/crawlproof.com/.env", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);

const login = env.DATAFORSEO_LOGIN;
const password = env.DATAFORSEO_PASSWORD;
const auth = "Basic " + Buffer.from(`${login}:${password}`).toString("base64");

const SEEDS = [
  "threat detection",
  "soc operations",
  "threat hunting",
  "siem",
  "incident response",
];

const STOPLIST = new Set([
  "the","and","for","with","you","your","that","this","from","into","over",
  "but","not","are","was","were","has","had","have","its","off","out",
  "all","any","new","get","how","why","what","who","best","top",
]);

function seedTokens(seed) {
  return seed
    .toLowerCase()
    .split(/[\s-]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 4 && !STOPLIST.has(t));
}

const aggregated = new Map();
let totalCost = 0;

for (const seed of SEEDS) {
  const body = [
    {
      keywords: [seed],
      location_code: 2840,
      language_code: "en",
      closely_variants: false,
      limit: 200,
      filters: [
        ["keyword_info.search_volume", ">=", 100],
        "and",
        ["keyword_properties.keyword_difficulty", "<=", 80],
      ],
      order_by: ["keyword_info.search_volume,desc"],
    },
  ];
  const res = await fetch(
    "https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json();
  const task = json.tasks?.[0];
  const items = task?.result?.[0]?.items ?? [];
  const tokens = seedTokens(seed);
  let kept = 0,
    dropped = 0;
  for (const it of items) {
    const kw = (it.keyword ?? "").toLowerCase();
    if (!kw || kw.split(/\s+/).length < 2) {
      dropped++;
      continue;
    }
    if (tokens.length > 0 && !tokens.some((t) => kw.includes(t))) {
      dropped++;
      continue;
    }
    const vol = it.keyword_info?.search_volume ?? 0;
    if (vol < 100) {
      dropped++;
      continue;
    }
    const existing = aggregated.get(kw);
    if (existing) {
      existing.matched.add(seed);
      if (vol > existing.vol) existing.vol = vol;
    } else {
      aggregated.set(kw, { kw: it.keyword, vol, matched: new Set([seed]) });
    }
    kept++;
  }
  totalCost += json.cost ?? 0;
  console.log(
    `  seed "${seed}": got=${items.length} kept=${kept} dropped=${dropped} tokens=${tokens.join(",")}`,
  );
}

const ranked = Array.from(aggregated.values()).sort((a, b) => {
  if (b.matched.size !== a.matched.size) return b.matched.size - a.matched.size;
  return b.vol - a.vol;
});

console.log(
  `\nTOTAL unique kept: ${ranked.length}  cost: $${totalCost.toFixed(3)}\n`,
);
console.log("Top 40 (multi-seed matches first, then by volume):");
for (const r of ranked.slice(0, 40)) {
  console.log(
    `  vol=${String(r.vol).padStart(7)}  matched=${r.matched.size}  ${r.kw}`,
  );
}
