const TAVILY_BASE = "https://api.tavily.com";

const DOCS_URLS: Record<string, string> = {
  search: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  extract: "https://docs.tavily.com/documentation/api-reference/endpoint/extract",
  crawl: "https://docs.tavily.com/documentation/api-reference/endpoint/crawl",
  map: "https://docs.tavily.com/documentation/api-reference/endpoint/map",
  research: "https://docs.tavily.com/documentation/api-reference/endpoint/research",
};

/** Remove empty-string, null, undefined, and empty-array values from params. */
function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (
      value !== "" &&
      value !== null &&
      value !== undefined &&
      !(Array.isArray(value) && value.length === 0)
    ) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

async function tavilyRequest(
  endpoint: string,
  method: "GET" | "POST",
  apiKey: string,
  body?: Record<string, unknown>,
  toolName?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const cleanedBody = method === "POST" && body ? cleanParams(body) : undefined;

  const res = await fetch(`${TAVILY_BASE}${endpoint}`, {
    method,
    headers,
    body: cleanedBody ? JSON.stringify(cleanedBody) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    const docsSuffix = toolName && DOCS_URLS[toolName]
      ? `\nDocumentation: ${DOCS_URLS[toolName]}`
      : "";
    throw new Error(`Tavily API error ${res.status}: ${text}${docsSuffix}`);
  }

  return res.json();
}

export async function search(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/search", "POST", apiKey, params, "search");
}

export async function extract(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/extract", "POST", apiKey, params, "extract");
}

export async function crawl(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/crawl", "POST", apiKey, params, "crawl");
}

export async function map(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/map", "POST", apiKey, params, "map");
}

export interface ResearchInitResponse {
  request_id: string;
  status: string;
}

export interface ResearchSource {
  url: string;
  title?: string;
  content?: string;
}

export interface ResearchPollResponse {
  status: string;
  content?: string;
  sources?: ResearchSource[];
}

export async function research(
  apiKey: string,
  params: Record<string, unknown>
): Promise<ResearchInitResponse> {
  return tavilyRequest("/research", "POST", apiKey, params, "research") as Promise<ResearchInitResponse>;
}

export async function getResearch(
  apiKey: string,
  requestId: string
): Promise<ResearchPollResponse> {
  return tavilyRequest(`/research/${requestId}`, "GET", apiKey, undefined, "research") as Promise<ResearchPollResponse>;
}

export interface UsageResponse {
  key: { usage: number; limit: number | null };
  account: { plan_limit: number; plan_usage: number };
}

export async function getUsage(apiKey: string): Promise<UsageResponse> {
  const res = await fetch(`${TAVILY_BASE}/usage`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<UsageResponse>;
}

export async function getRemainingCredit(apiKey: string): Promise<number> {
  const data = await getUsage(apiKey);
  const limit = data.key.limit ?? data.account.plan_limit;
  const usage = data.key.usage;
  return Math.max(0, limit - usage);
}
