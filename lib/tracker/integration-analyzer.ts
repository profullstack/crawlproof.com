import { createHash } from "node:crypto";

export type IntegrationEndpoint = {
  url: string;
  host: string;
  path: string;
  method: string;
  transport: string;
};

export type IntegrationAnalysis = {
  source: {
    inputType: "script-tag" | "url" | "raw";
    scriptUrl: string | null;
    origin: string | null;
    attributes: Record<string, string>;
    fetchedBytes: number;
    sha256: string | null;
    contentType: string | null;
    httpStatus: number | null;
  };
  endpoints: IntegrationEndpoint[];
  globals: string[];
  methods: string[];
  configKeys: string[];
  events: string[];
  authHints: string[];
  warnings: string[];
  summary: string[];
};

export type IntegrationSource = {
  inputType: "script-tag" | "url" | "raw";
  scriptUrl: string | null;
  attributes: Record<string, string>;
  inlineScript: string;
};

const INTERESTING_METHODS = new Set([
  "alias",
  "capture",
  "event",
  "identify",
  "init",
  "off",
  "on",
  "page",
  "ready",
  "setuser",
  "track",
]);

const IGNORED_OBJECTS = new Set([
  "console",
  "document",
  "history",
  "json",
  "localstorage",
  "location",
  "math",
  "navigator",
  "performance",
  "sessionstorage",
  "window",
]);

export function extractIntegrationSource(input: string): IntegrationSource {
  const trimmed = input.trim();
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script>/i.exec(trimmed);
  if (script) {
    const attributes = parseAttributes(script[1] ?? "");
    return {
      inputType: "script-tag",
      scriptUrl: normalizeScriptSrc(attributes.src),
      attributes,
      inlineScript: script[2] ?? "",
    };
  }

  const bareUrl = parseHttpUrl(trimmed);
  if (bareUrl) {
    return {
      inputType: "url",
      scriptUrl: bareUrl,
      attributes: {},
      inlineScript: "",
    };
  }

  return {
    inputType: "raw",
    scriptUrl: null,
    attributes: {},
    inlineScript: trimmed,
  };
}

export function analyzeIntegration(input: {
  originalInput: string;
  fetchedText?: string;
  fetchedBytes?: number;
  contentType?: string | null;
  httpStatus?: number | null;
}): IntegrationAnalysis {
  const source = extractIntegrationSource(input.originalInput);
  const baseUrl = source.scriptUrl ? parseHttpUrl(source.scriptUrl) : null;
  const code = input.fetchedText ?? source.inlineScript ?? input.originalInput;
  const origin = baseUrl ? new URL(baseUrl).origin : null;
  const fetchedBytes =
    input.fetchedBytes ?? (input.fetchedText ? Buffer.byteLength(input.fetchedText) : 0);
  const sha256 = input.fetchedText
    ? createHash("sha256").update(input.fetchedText).digest("hex")
    : null;

  const endpoints = findEndpoints(code, baseUrl);
  const globals = unique([
    ...matches(code, /(?:window|globalThis|self)\.([A-Za-z_$][\w$]*)\s*=/g),
    ...matches(code, /(?:window|globalThis|self)\[['"]([^'"]+)['"]\]\s*=/g),
  ]).slice(0, 20);
  const methods = findMethods(code);
  const configKeys = findConfigKeys(code, source.attributes);
  const events = findEvents(code);
  const authHints = findAuthHints(code, source.attributes);
  const warnings = buildWarnings(code, endpoints, source, input.httpStatus ?? null);

  return {
    source: {
      inputType: source.inputType,
      scriptUrl: baseUrl,
      origin,
      attributes: redactAttributes(source.attributes),
      fetchedBytes,
      sha256,
      contentType: input.contentType ?? null,
      httpStatus: input.httpStatus ?? null,
    },
    endpoints,
    globals,
    methods,
    configKeys,
    events,
    authHints,
    warnings,
    summary: buildSummary({ source, endpoints, globals, methods, configKeys, events }),
  };
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:@A-Za-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of raw.matchAll(re)) {
    const key = match[1]?.toLowerCase();
    if (!key) continue;
    attrs[key] = match[2] ?? match[3] ?? match[4] ?? "true";
  }
  return attrs;
}

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeScriptSrc(value: string | undefined) {
  if (!value) return null;
  if (value.startsWith("//")) return `https:${value}`;
  return value;
}

function findEndpoints(code: string, baseUrl: string | null): IntegrationEndpoint[] {
  const found: IntegrationEndpoint[] = [];
  const baseVariables = findScriptBaseVariables(code);
  const absolute = /(['"`])((?:https?:)?\/\/[^'"`\s<>)\\]+)\1/g;
  for (const match of code.matchAll(absolute)) {
    const raw = (match[2] ?? "").startsWith("//")
      ? `${baseUrl ? new URL(baseUrl).protocol : "https:"}${match[2]}`
      : match[2];
    pushEndpoint(found, raw, contextFor(code, match.index ?? 0), baseUrl);
  }

  const callWithPath =
    /\b(fetch|sendBeacon|open|post|postJSON|getJSON)\s*\(\s*(['"`])([^'"`]+)\2/gi;
  for (const match of code.matchAll(callWithPath)) {
    pushEndpoint(
      found,
      match[3] ?? "",
      `${match[1] ?? ""} ${contextFor(code, match.index ?? 0)}`,
      baseUrl,
    );
  }

  if (baseUrl) {
    const dynamicCall =
      /\b(fetch|sendBeacon|open|post|postJSON|getJSON)\s*\(\s*([A-Za-z_$][\w$]*)\s*\+\s*(['"`])([^'"`]+)\3/gi;
    for (const match of code.matchAll(dynamicCall)) {
      if (!baseVariables.has(match[2] ?? "")) continue;
      pushEndpoint(
        found,
        match[4] ?? "",
        `${match[1] ?? ""} ${contextFor(code, match.index ?? 0)}`,
        baseUrl,
      );
    }

    const xhrOpen =
      /\.open\s*\(\s*(['"`])([A-Z]+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\+\s*(['"`])([^'"`]+)\4/gi;
    for (const match of code.matchAll(xhrOpen)) {
      if (!baseVariables.has(match[3] ?? "")) continue;
      pushEndpoint(
        found,
        match[5] ?? "",
        `method: "${match[2] ?? "GET"}" ${contextFor(code, match.index ?? 0)}`,
        baseUrl,
      );
    }
  }

  return uniqueBy(found, (endpoint) => `${endpoint.method} ${endpoint.url}`).slice(0, 25);
}

function findScriptBaseVariables(code: string) {
  const variables = new Set<string>();
  for (const match of code.matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:currentScript|document\.currentScript)\.src\b/g,
  )) {
    if (match[1]) variables.add(match[1]);
  }
  for (const match of code.matchAll(
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:currentScript|document\.currentScript)\.src\.replace\(/g,
  )) {
    if (match[1]) variables.add(match[1]);
  }
  return variables;
}

function pushEndpoint(
  endpoints: IntegrationEndpoint[],
  raw: string,
  context: string,
  baseUrl: string | null,
) {
  const url = endpointUrl(raw, baseUrl);
  if (!url) return;
  endpoints.push({
    url: url.toString(),
    host: url.hostname,
    path: `${url.pathname}${url.search ? "?..." : ""}`,
    method: inferMethod(context),
    transport: inferTransport(context),
  });
}

function endpointUrl(raw: string, baseUrl: string | null): URL | null {
  const value = raw.trim();
  if (!value || value.startsWith("javascript:") || value.startsWith("data:")) return null;
  try {
    if (value.startsWith("http://") || value.startsWith("https://")) return new URL(value);
    if (value.startsWith("//")) return new URL(`https:${value}`);
    if (value.startsWith("/") && baseUrl) return new URL(value, baseUrl);
  } catch {
    return null;
  }
  return null;
}

function contextFor(code: string, index: number) {
  return code.slice(Math.max(0, index - 120), Math.min(code.length, index + 160));
}

function inferMethod(context: string) {
  const explicit = /\bmethod\s*:\s*['"]([A-Z]+)['"]/i.exec(context);
  if (explicit?.[1]) return explicit[1].toUpperCase();
  if (/sendBeacon/i.test(context)) return "POST";
  if (/\bpost(?:JSON)?\s*\(/i.test(context)) return "POST";
  return "GET";
}

function inferTransport(context: string) {
  if (/sendBeacon/i.test(context)) return "sendBeacon";
  if (/XMLHttpRequest|\.open\s*\(/i.test(context)) return "xhr";
  if (/\bfetch\s*\(/i.test(context)) return "fetch";
  if (/new\s+Image|\.src\s*=/i.test(context)) return "pixel";
  return "url";
}

function findMethods(code: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/g)) {
    const objectName = (match[1] ?? "").toLowerCase();
    const method = match[2] ?? "";
    if (IGNORED_OBJECTS.has(objectName)) continue;
    if (INTERESTING_METHODS.has(method.toLowerCase())) out.push(method);
  }
  for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1] ?? "";
    if (INTERESTING_METHODS.has(name.toLowerCase())) out.push(name);
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = match[1] ?? "";
    if (INTERESTING_METHODS.has(name.toLowerCase())) out.push(name);
  }
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*function\s*\(/g)) {
    const name = match[1] ?? "";
    out.push(name);
  }
  return unique(out).slice(0, 30);
}

function findConfigKeys(code: string, attributes: Record<string, string>) {
  const keys = Object.keys(attributes)
    .filter((key) => key.startsWith("data-"))
    .map((key) => key.replace(/^data-/, ""));
  keys.push(...matches(code, /\.dataset\.([A-Za-z_$][\w$]*)/g));
  keys.push(...matches(code, /getAttribute\(\s*['"]data-([^'"]+)['"]\s*\)/g));
  keys.push(
    ...matches(
      code,
      /['"]?(apiKey|auto|domain|endpoint|host|key|projectId|site|token|websiteId)['"]?\s*:/gi,
    ),
  );
  return unique(keys.map((key) => key.replace(/[^A-Za-z0-9_.:-]/g, "").toLowerCase())).slice(0, 30);
}

function findEvents(code: string) {
  return unique(
    [
      ...matches(code, /\b(?:track|capture|event)\s*\(\s*(['"`])([A-Za-z0-9_.:-]{1,80})\1/g, 2),
      ...matches(code, /\btype\s*:\s*(['"`])([A-Za-z0-9_.:-]{1,80})\1/g, 2),
    ],
  ).slice(0, 30);
}

function findAuthHints(code: string, attributes: Record<string, string>) {
  const hints: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (/key|token|secret|id/i.test(key) && value && value !== "true") {
      hints.push(`${key}=${redactSecret(value)}`);
    }
  }
  for (const match of code.matchAll(/\b(pk_[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,})\b/g)) {
    hints.push(redactSecret(match[1] ?? ""));
  }
  return unique(hints).slice(0, 20);
}

function buildWarnings(
  code: string,
  endpoints: IntegrationEndpoint[],
  source: IntegrationSource,
  httpStatus: number | null,
) {
  const warnings: string[] = [];
  if (httpStatus && (httpStatus < 200 || httpStatus >= 300)) {
    warnings.push(`Fetch returned HTTP ${httpStatus}.`);
  }
  if (source.scriptUrl && endpoints.length === 0) {
    warnings.push("No public network endpoints were visible in static analysis.");
  }
  if (code.length > 0 && code.split("\n").length <= 3 && code.length > 4000) {
    warnings.push("Script appears minified; dynamic endpoint construction may be incomplete.");
  }
  if (/\beval\s*\(|new\s+Function\b/.test(code)) {
    warnings.push("Script uses dynamic code execution; static API mapping may be partial.");
  }
  return warnings;
}

function buildSummary(input: {
  source: IntegrationSource;
  endpoints: IntegrationEndpoint[];
  globals: string[];
  methods: string[];
  configKeys: string[];
  events: string[];
}) {
  const summary: string[] = [];
  if (input.source.scriptUrl) summary.push(`Source script: ${input.source.scriptUrl}`);
  if (input.endpoints.length) {
    summary.push(
      `Discovered ${input.endpoints.length} public endpoint${input.endpoints.length === 1 ? "" : "s"}.`,
    );
  }
  if (input.globals.length) summary.push(`Global SDK object: ${input.globals[0]}.`);
  if (input.methods.length) summary.push(`SDK calls: ${input.methods.slice(0, 5).join(", ")}.`);
  if (input.configKeys.length) {
    summary.push(`Config keys: ${input.configKeys.slice(0, 5).join(", ")}.`);
  }
  if (input.events.length) summary.push(`Named events: ${input.events.slice(0, 5).join(", ")}.`);
  if (summary.length === 0) summary.push("Stored pasted input for manual adapter mapping.");
  return summary;
}

function redactAttributes(attributes: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      /key|token|secret/i.test(key) ? redactSecret(value) : value,
    ]),
  );
}

function redactSecret(value: string) {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function matches(code: string, re: RegExp, group = 1) {
  const out: string[] = [];
  for (const match of code.matchAll(re)) {
    const value = match[group];
    if (value) out.push(value);
  }
  return out;
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueBy<T>(values: T[], keyFor: (value: T) => string) {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyFor(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
