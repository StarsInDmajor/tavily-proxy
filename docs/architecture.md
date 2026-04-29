# Architecture

## Overview

```
                          ┌──────────────────────────────────────────┐
                          │            tavily-proxy (:9100)          │
                          │                                          │
  MCP clients ──────────► │  /mcp   (Streamable HTTP, 2025-11-25)   │
  (x-api-key header)      │  /sse   (legacy SSE, 2024-11-05)       │
                          │          │                               │
  REST clients ─────────► │  /search /extract /crawl /map /research │
  (api_key in body)       │          │                               │
                          │     ┌────▼─────┐                        │
                          │     │ Auth     │                        │
                          │     │ check    │                        │
                          │     └────┬─────┘                        │
                          │          │                               │
                          │     ┌────▼─────┐    ┌──────────────┐   │
                          │     │ Key Pool │◄──►│ key-store.json│   │
                          │     │ (in-mem) │    │ (file-backed) │   │
                          │     └────┬─────┘    └──────────────┘   │
                          │          │                               │
                          │     pick best key                        │
                          │          │                               │
                          │     ┌────▼──────────────────────────┐   │
                          │     │  Tavily API (api.tavily.com)  │   │
                          │     │  Bearer <pool-key>             │   │
                          │     └───────────────────────────────┘   │
                          └──────────────────────────────────────────┘
```

The proxy has three layers:

1. **Auth layer** — verifies the caller's management key (different from the Tavily API keys in the pool)
2. **Key pool** — selects the best Tavily API key for each request, handles rotation and rate limiting
3. **Upstream client** — forwards the request to `api.tavily.com` using the selected pool key

## Authentication Model

There are **two distinct keys**:

| Key | Purpose | Where used |
|-----|---------|------------|
| **Management key** (`authKey`) | Authenticates *callers* (you, your agents) to the proxy | `x-api-key` header (MCP/management) or `api_key` body field (REST) |
| **Pool keys** (`tvly-*`) | Authenticates the *proxy* to Tavily's API | Injected automatically by the key pool — callers never see these |

The management key is compared with **timing-safe equality** to prevent timing attacks.

### Auth paths

```
MCP tools (/mcp, /sse)         → x-api-key header → timing-safe compare
REST endpoints (/search, etc.) → api_key in body OR Authorization: Bearer OR x-api-key header
Key management (/api/keys)     → x-api-key header only
Health check (GET /)           → no auth required
Discovery (/.well-known/mcp)   → no auth required
```

## Key Pool

The key pool (`LocalKVStore` in `key-pool.ts`) is a file-backed JSON store with an in-memory cache, protected by an async mutex for concurrency safety.

### Key Selection Algorithm

`pickBestKey()` runs under the mutex and follows this logic:

1. **Filter** — exclude keys where:
   - `remainingCredit <= 0`
   - `enabled === false`
   - `disabledUntil` is in the future (temporarily disabled)
2. **Sort** — descending by `remainingCredit` (highest first)
3. **Rate-limit check** — walk the sorted list looking for a key not rate-limited (elapsed time since `lastRequestTime` ≥ `1000 / qps` ms)
4. **Atomic soft-lock** — stamp `lastRequestTime = Date.now()` on the chosen key *before* returning, so concurrent callers cannot pick the same key within the same QPS window
5. **Fallback wait** — if all keys are rate-limited, wait for the best key's QPS window to expire (capped at 10 s), then stamp and return it

If no key is available at all (empty pool, all expired, or wait exceeds 10 s), the request fails with a clear error message.

### Credit Tracking

After every successful request, the proxy calls Tavily's `GET /usage` endpoint to sync the key's remaining credit:

```
remainingCredit = max(0, key.limit - key.usage)
```

If `key.limit` is `null` (unlimited key), it falls back to `account.plan_limit`.

This means the proxy always has an up-to-date view of each key's balance for the next `pickBestKey()` call.

### Error Handling

| Error type | Response | Key effect |
|------------|----------|------------|
| **401/403 from Tavily** | Immediate retry with next key | Credit set to `-1000` (effectively dead) |
| **Other errors** (429, 500, network) | Error returned to caller | `consecutiveErrors` incremented |
| **3 consecutive non-auth errors** | Key temporarily disabled | `disabledUntil` = now + 5 minutes |
| **Successful request** | Normal response | `consecutiveErrors` reset to 0, `disabledUntil` cleared |

### Key Fallback (MCP)

For MCP tool calls, `withKeyFallback()` automatically retries with the next available pool key on 401/403 errors. It tracks tried keys in a `Set` to avoid infinite loops:

```
key A → 401 → invalidate, try next
key B → 401 → invalidate, try next
key C → success → return result
```

If all keys are exhausted, it returns an MCP error response (`isError: true`).

### Key Fallback (REST)

REST endpoints use `withKeyFallbackRaw()` — same logic, but throws on non-auth errors instead of returning an error object (the caller gets an HTTP 500 with the error message).

### Runtime State File

The runtime state (`TAVILY_STORE_PATH`) is a JSON file with this structure:

```json
{
  "version": "1.1",
  "lastSync": "2025-04-29T10:30:00.000Z",
  "keys": {
    "tvly-xxxxxxxxxxxx": {
      "credit": 850,
      "lastUsed": "2025-04-29T10:30:00.000Z",
      "enabled": true,
      "qps": 1,
      "lastRequestTime": 1745920200000,
      "consecutiveErrors": 0,
      "disabledUntil": null
    }
  }
}
```

Persistence is atomic (write to `.tmp`, then `rename`).

## MCP Transports

The proxy supports two MCP transport protocols simultaneously:

### Streamable HTTP (`/mcp`)

- **Protocol version**: `2025-11-25`
- **Mode**: Stateless — a new `McpServer` + `WebStandardStreamableHTTPServerTransport` is created per request (no session management)
- **Clients**: OpenCode, and any client using the Streamable HTTP transport
- **Accept header fix**: the proxy injects `Accept: application/json, text/event-stream` if the client omits it, working around a common MCP client issue

### Legacy SSE (`/sse`)

- **Protocol version**: `2024-11-05`
- **Endpoints**: `GET /sse` (connect) + `POST /sse/message?sessionId=xxx` (send)
- **Session management**: transports stored in an in-memory `Map<string, SSEServerTransport>`
- **Cleanup**: sessions are removed on `abort` signal (client disconnect)
- **External path**: when `TAVILY_EXTERNAL_PATH` is set, the SSE message endpoint is prefixed (e.g., `/tavily/sse/message` instead of `/sse/message`) for reverse proxy setups

### MCP Discovery

`GET /.well-known/mcp` returns a JSON document advertising both transports, capabilities, and auth requirements — following the MCP server discovery spec.

## Research (Async Flow)

The research endpoint is fundamentally different from the other four tools because Tavily's research API is **asynchronous**:

### MCP path (blocking)

When called as an MCP tool, the proxy handles the full lifecycle internally:

```
1. POST /research → get request_id
2. Poll GET /research/{request_id} with exponential backoff
   - Initial: poll_interval seconds (default 2)
   - Backoff: ×1.5 per poll, capped at 10 s
   - Timeout: 300 s (mini) or 900 s (pro/auto)
3. Return completed/failed result as MCP tool response
```

The key used to initiate the research is tracked internally. After completion, credits are synced.

### REST path (async)

When called via REST, the proxy returns the `request_id` immediately and the caller polls manually:

```
1. POST /research → { request_id, status: "pending", ... }
   (key is stored in researchKeyMap)
2. GET /research/{requestId} → poll until completed/failed
   (uses the stored key; falls back to best pool key if not found)
3. On completion: credit sync + cleanup from researchKeyMap
```

This matches Tavily's native async API pattern.

## Startup Sequence

```
1. Read TAVILY_AUTH_KEY from env (or authKey from key store JSON)
2. Create LocalKVStore at TAVILY_STORE_PATH
3. Load initial keys from TAVILY_KEY_STORE_PATH (if set):
   - Parse JSON, iterate keys array
   - Call kv.put(key, credit) for each entry
4. Create Hono app with auth middleware + routes
5. Start HTTP server on TAVILY_PORT
```

If `TAVILY_KEY_STORE_PATH` is set but the file is unreadable, the process exits with a fatal error. If it's unset, the pool starts empty (keys can be added via the management API or CLI).
