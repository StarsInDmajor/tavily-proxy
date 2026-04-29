# Tavily Proxy

Self-hosted proxy that sits between your clients and the [Tavily API](https://tavily.com/), providing a shared API key pool with automatic rotation, rate-limit-aware key selection, and dual-protocol MCP access.

## Why

- **Multi-key pool** — register multiple Tavily API keys; the proxy automatically picks the one with the most remaining credits per request
- **Transparent rotation** — 401/403 keys are invalidated on the spot; 3 consecutive errors trigger a 5-minute cooldown; keys recover automatically
- **Rate-limit aware** — respects per-key QPS limits (default 1 QPS) with in-memory mutex and automatic wait (capped at 10 s)
- **Dual MCP transports** — Streamable HTTP (`/mcp`, protocol `2025-11-25`) for modern clients and legacy SSE (`/sse`, protocol `2024-11-05`) for older ones
- **Tavily-compatible REST API** — drop-in replacement for `https://api.tavily.com/*` (search, extract, crawl, map, research)
- **Credit tracking** — syncs remaining credits from Tavily's `/usage` endpoint after every successful request

## Quick Start

```bash
# 1. Create a key store file
cat > keys.json << 'EOF'
{
  "authKey": "your-secret-management-key",
  "keys": [
    { "key": "tvly-xxxxxxxxxxxx", "credit": 1000 },
    { "key": "tvly-yyyyyyyyyyyy", "credit": 1000 }
  ]
}
EOF

# 2. Start the proxy
npx tavily-proxy                           # if installed via npm
# — or —
nix run github:StarsInDmajor/tavily-proxy  # if using Nix

# With environment variables
TAVILY_KEY_STORE_PATH=./keys.json TAVILY_PORT=9100 node dist/src/index.js
```

The proxy listens on `http://localhost:9100` by default.

## Usage

### MCP (OpenCode, Claude Code, etc.)

```json
{
  "mcpServers": {
    "tavily-proxy": {
      "url": "http://localhost:9100/mcp",
      "headers": { "x-api-key": "your-secret-management-key" }
    }
  }
}
```

Five MCP tools are exposed: `tavily-search`, `tavily-extract`, `tavily-crawl`, `tavily-map`, `tavily-research`. Parameters match the [official Tavily API](https://docs.tavily.com/documentation/api-reference) one-to-one.

### REST API

Drop-in replacement — send requests to `localhost:9100` instead of `api.tavily.com`:

```bash
# Search
curl -X POST http://localhost:9100/search \
  -H "Content-Type: application/json" \
  -d '{"api_key": "your-secret-management-key", "query": "test"}'

# Extract
curl -X POST http://localhost:9100/extract \
  -H "Content-Type: application/json" \
  -d '{"api_key": "your-secret-management-key", "urls": ["https://example.com"]}'
```

### Key Management CLI

```bash
tavily-cli status          # Service status + key list
tavily-cli add tvly-xxx    # Add a key (syncs credits from Tavily)
tavily-cli remove tvly-xxx # Remove a key
tavily-cli list            # List keys with remaining credits
tavily-cli health          # Health check
```

## Documentation

| Document | Contents |
|----------|----------|
| [Architecture](docs/architecture.md) | Key pool algorithm, auth model, MCP transports, research async flow |
| [API Reference](docs/api.md) | REST endpoints, MCP tools, key management API, error responses |
| [Deployment](docs/deployment.md) | Home Manager module, environment variables, reverse proxy setup |
| [Development](docs/development.md) | Project structure, testing, building, Nix integration |

## Credit Costs (upstream Tavily)

| Operation | Cost |
|-----------|------|
| Search `basic` | 1 credit |
| Search `advanced` | 2 credits |
| Extract `basic` | 1 credit / 5 URLs |
| Extract `advanced` | 2 credits / 5 URLs |
| Crawl | 2 credits / call |
| Map | 1 credit / 10 pages (2 with `instructions`) |
| Research `mini` | 4–20 credits |
| Research `pro` | 20–250 credits |

The proxy tracks credits per key via Tavily's `/usage` endpoint and selects the key with the highest remaining balance.

## License

MIT
