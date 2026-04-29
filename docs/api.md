# API Reference

## Authentication

All endpoints (except health check and discovery) require authentication:

| Endpoint type | Auth method |
|---------------|-------------|
| MCP (`/mcp`, `/sse`) | `x-api-key` header |
| REST (`/search`, `/extract`, `/crawl`, `/map`, `/research`) | `api_key` in body **or** `Authorization: Bearer` header **or** `x-api-key` header |
| Key management (`/api/keys`) | `x-api-key` header |
| Health check (`GET /`) | None |
| Discovery (`GET /.well-known/mcp`) | None |

---

## REST Endpoints

REST endpoints are drop-in replacements for `https://api.tavily.com/*`. The proxy strips the `api_key` field from the body before forwarding to Tavily, replacing it with a pool key via `Authorization: Bearer`.

### POST /search

Search the web. [Tavily docs](https://docs.tavily.com/documentation/api-reference/endpoint/search)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | **required** | Search query (keep under 400 chars) |
| `search_depth` | `ultra-fast` \| `fast` \| `basic` \| `advanced` | `basic` | Speed vs. relevance tradeoff |
| `topic` | `general` \| `news` \| `finance` | `general` | Topic category |
| `max_results` | 0–20 | 5 | Number of results |
| `time_range` | `day` \| `week` \| `month` \| `year` \| `d` \| `w` \| `m` \| `y` | — | Recency filter |
| `start_date` | string (YYYY-MM-DD) | — | Include results after this date |
| `end_date` | string (YYYY-MM-DD) | — | Include results before this date |
| `include_answer` | bool \| `basic` \| `advanced` | false | Include AI-generated answer |
| `include_raw_content` | bool \| `markdown` \| `text` | false | Include full page content |
| `include_images` | bool | false | Include image results |
| `include_image_descriptions` | bool | false | Add descriptions to images (requires `include_images`) |
| `include_favicon` | bool | false | Include favicon URL per result |
| `include_domains` | string[] | — | Restrict to these domains |
| `exclude_domains` | string[] | — | Exclude these domains |
| `chunks_per_source` | 1–3 | — | Snippets per source (`advanced` depth only) |
| `country` | string | — | Boost results from country (forces `topic: general`) |

**Proxy behavior**: after a successful search, credits are synced from Tavily's `/usage` endpoint. Setting `country` overrides `topic` to `general`. `start_date`/`end_date` and `time_range` are mutually exclusive (dates take precedence).

**Cost**: 1 credit (`basic`), 2 credits (`advanced`).

### POST /extract

Extract content from URLs. [Tavily docs](https://docs.tavily.com/documentation/api-reference/endpoint/extract)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `urls` | string \| string[] | **required** | One or more URLs (max 20) |
| `query` | string | — | Rerank chunks by relevance to this query |
| `extract_depth` | `basic` \| `advanced` | `basic` | `advanced` for JS-rendered pages |
| `format` | `markdown` \| `text` | `markdown` | Output format |
| `chunks_per_source` | 1–5 | — | Chunks per URL (requires `query`) |
| `include_images` | bool | false | Include image URLs |
| `include_favicon` | bool | false | Include favicon URL |

**Cost**: 1 credit per 5 URLs (`basic`), 2 credits per 5 URLs (`advanced`).

### POST /crawl

Graph-based website traversal with content extraction. [Tavily docs](https://docs.tavily.com/documentation/api-reference/endpoint/crawl)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | **required** | Root URL to crawl |
| `instructions` | string | — | Natural language guidance for the crawler |
| `max_depth` | 1–5 | 1 | Levels deep to traverse |
| `max_breadth` | 1–500 | 20 | Links to follow per page |
| `limit` | int ≥ 1 | 50 | Total pages cap |
| `select_paths` | string[] | — | Regex patterns for paths to include |
| `select_domains` | string[] | — | Domains to include |
| `exclude_paths` | string[] | — | Regex patterns for paths to exclude |
| `exclude_domains` | string[] | — | Domains to exclude |
| `allow_external` | bool | true | Follow links to external domains |
| `include_images` | bool | false | Include images |
| `extract_depth` | `basic` \| `advanced` | `basic` | Extraction depth |
| `format` | `markdown` \| `text` | `markdown` | Output format |
| `chunks_per_source` | 1–5 | — | Chunks per page |
| `include_favicon` | bool | false | Include favicon URL |

**Cost**: 2 credits per call.

### POST /map

Discover URLs on a website without extracting content. [Tavily docs](https://docs.tavily.com/documentation/api-reference/endpoint/map)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | **required** | Root URL to map |
| `instructions` | string | — | Natural language guidance (doubles cost) |
| `max_depth` | 1–5 | 1 | Levels deep to traverse |
| `max_breadth` | 1–500 | 20 | Links to follow per page |
| `limit` | int ≥ 1 | 50 | Max URLs to discover |
| `select_paths` | string[] | — | Regex patterns for paths to include |
| `select_domains` | string[] | — | Domains to include |
| `exclude_paths` | string[] | — | Regex patterns for paths to exclude |
| `exclude_domains` | string[] | — | Domains to exclude |
| `allow_external` | bool | true | Include external domain links |

**Cost**: 1 credit per 10 pages (2 with `instructions`).

### POST /research

Start an async research job. Returns immediately with a `request_id`. [Tavily docs](https://docs.tavily.com/documentation/api-reference/endpoint/research)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `input` | string | **required** | Research question or topic |
| `model` | `mini` \| `pro` \| `auto` | `auto` | Research depth |
| `citation_format` | `numbered` \| `mla` \| `apa` \| `chicago` | `numbered` | Citation style |
| `output_schema` | object | — | JSON schema to structure output |

**Response** (201):

```json
{
  "request_id": "123e4567-e89b-12d3-a456-426614174111",
  "status": "pending",
  "created_at": "2025-01-15T10:30:00Z",
  "input": "...",
  "model": "mini"
}
```

The proxy tracks which pool key initiated the request in an in-memory map (`researchKeyMap`).

**Cost**: 4–20 credits (`mini`), 20–250 credits (`pro`).

### GET /research/:requestId

Poll a research job's status.

| Parameter | Location | Description |
|-----------|----------|-------------|
| `requestId` | URL path | The request ID from the POST /research response |

**Auth**: no auth required (the proxy uses the stored pool key, or falls back to the best available key).

**Response**:

```json
{
  "status": "completed",
  "content": "# Research Report\n\n...",
  "sources": [
    { "url": "https://...", "title": "...", "content": "..." }
  ]
}
```

Possible `status` values: `pending`, `running`, `completed`, `failed`.

On completion or failure, the proxy syncs credits and removes the `requestId` from the internal map.

---

## MCP Tools

Five tools are registered on the MCP server. Parameters are validated with Zod schemas and match the REST API parameters exactly, with these additions:

### tavily-search

Same parameters as [POST /search](#post-search), plus proxy-level behavior:
- Setting `country` forces `topic = "general"`
- `start_date`/`end_date` takes precedence over `time_range` (mutually exclusive)

### tavily-extract

Same parameters as [POST /extract](#post-extract).

### tavily-crawl

Same parameters as [POST /crawl](#post-crawl).

### tavily-map

Same parameters as [POST /map](#post-map).

### tavily-research

Same parameters as [POST /research](#post-research), plus:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `poll_interval` | int (seconds) | 2 | Initial poll interval (exponential backoff ×1.5, capped at 10 s) |
| `timeout` | int (seconds) | 300 (mini) / 900 (pro/auto) | Max wait time before giving up |

The MCP tool is **blocking** — it polls internally until the job completes, fails, or times out. On timeout, the response includes the `request_id` for manual follow-up via the REST API.

---

## Key Management API

All management endpoints require `x-api-key` header authentication.

### POST /api/keys

Add a new Tavily API key to the pool. The proxy immediately syncs credits from Tavily's `/usage` endpoint.

**Request**:

```json
{ "apiKey": "tvly-xxxxxxxxxxxx" }
```

**Response**:

```json
{
  "success": true,
  "key": {
    "apiKey": "tvly-xxxxxxxxxxxx",
    "remainingCredit": 850
  }
}
```

### DELETE /api/keys

Remove a key from the pool.

**Request**:

```json
{ "apiKey": "tvly-xxxxxxxxxxxx" }
```

**Response**:

```json
{
  "success": true,
  "deleted": "tvly-xxxxxxxxxxxx"
}
```

### GET /api/keys

List all keys in the pool. API keys are masked (first 8 characters + `...`).

**Response**:

```json
{
  "keys": [
    {
      "apiKey": "tvly-xxx...",
      "remainingCredit": 850,
      "lastUsed": "2025-04-29T10:30:00.000Z",
      "enabled": true,
      "qps": 1,
      "lastRequestTime": 1745920200000,
      "disabledUntil": null
    }
  ]
}
```

---

## Service Endpoints

### GET /

Health check and service info. No auth required.

```json
{
  "service": "tavily-proxy",
  "version": "1.0.0",
  "transports": {
    "streamableHttp": {
      "protocol": "2025-11-25",
      "endpoint": "POST /mcp"
    },
    "sse": {
      "protocol": "2024-11-05",
      "endpoints": {
        "connect": "GET /sse",
        "message": "POST /sse/message?sessionId=xxx"
      }
    }
  },
  "restApi": { "..." },
  "keyManagement": { "..." }
}
```

### GET /.well-known/mcp

MCP server discovery. No auth required. Returns transport endpoints, capabilities, and auth requirements.

---

## Error Responses

### Auth errors (401)

```json
{ "error": "Unauthorized: invalid or missing x-api-key header" }
```

### Upstream errors (500)

When Tavily returns an error, the proxy includes the upstream docs URL:

```json
{ "error": "Tavily API error 429: Rate limit exceeded\nDocumentation: https://docs.tavily.com/documentation/api-reference/endpoint/search" }
```

### Key exhaustion

```json
{ "error": "No available API keys in the pool. Please add keys first." }
```

For MCP tools, this is returned as:

```json
{
  "content": [{ "type": "text", "text": "Error: No available API keys in the pool. Please add keys first." }],
  "isError": true
}
```

### Research timeout (MCP only)

```json
{
  "content": [{ "type": "text", "text": "Research timed out after 300s. Request ID: 123e4567-..." }],
  "isError": true
}
```

---

## Tavily API Rate Limits (upstream)

These are Tavily's native rate limits per API key. The proxy's QPS-based rate limiting is separate and protects against exceeding these.

| Endpoint | Dev RPM | Prod RPM |
|----------|---------|----------|
| Search, Extract, Map | 100 | 1,000 |
| Crawl | 100 | 100 |
| Research (create) | 20 | 20 |
| Usage | 10 / 10 min | 10 / 10 min |

When Tavily rate-limits a request, it returns `429` with a `retry-after` header. The proxy treats this as a non-auth error (increments `consecutiveErrors`).

---

## Decision Guide

```
Do you have specific URLs to read?
├── Yes → tavily-extract
└── No
    ├── Do you need a full site overview / all links?
    │   ├── Yes → tavily-map (then extract or crawl relevant paths)
    │   └── No
    │       ├── Do you need content from many pages of one site?
    │       │   ├── Yes → tavily-crawl
    │       │   └── No
    │       │       ├── Do you need a synthesised report from many sources?
    │       │       │   ├── Yes → tavily-research
    │       │       │   └── No → tavily-search
```

### Standard workflow (escalating depth)

1. **search** — find relevant pages and get initial snippets
2. **extract** — read the most promising pages in full
3. **map** — understand a site's structure before bulk extraction
4. **crawl** — bulk-extract all pages under a path
5. **research** — synthesise everything into a report when search+extract isn't enough

### Credit guidance

| Task | Recommended tools | Typical cost |
|------|-------------------|--------------|
| Quick lookup | `search` (`basic`) | 1 credit |
| Read a page | `extract` (`basic`) | 1 credit |
| Read 10 pages | `extract` (`basic`, batch) | 2 credits |
| Ingest a docs section | `map` → `crawl` with `select_paths` | 3–10 credits |
| Deep research report | `research` (`mini`) | 4–20 credits |
| Comprehensive analysis | `research` (`pro`) | 20–250 credits |
