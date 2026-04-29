# Tavily Proxy

Self-hosted Tavily MCP proxy with local API key pool.

Replaces per-client Tavily API keys with a shared key pool that automatically rotates keys based on remaining credits, rate limits, and error states.

## Features

- **Multi-key pool**: Manage multiple Tavily API keys, automatically pick the one with the most remaining credits
- **MCP server**: Exposes both Streamable HTTP (`/mcp`) and legacy SSE (`/sse`) transports
- **REST API**: Tavily-compatible REST endpoints (`/search`, `/extract`, `/crawl`, `/map`, `/research`)
- **Key management**: CLI and REST API for adding/removing/listing keys
- **Rate limiting**: Respects per-key QPS limits with automatic wait
- **Error handling**: Temporarily disables keys after 3 consecutive errors, re-enables after cooldown

## Quick Start

```bash
# Set required environment variables
export TAVILY_AUTH_KEY="your-management-key"
export TAVILY_STORE_PATH="/path/to/key-store.json"

# Optional: load initial keys from a JSON file
export TAVILY_KEY_STORE_PATH="/path/to/keys.json"

# Start the proxy
npm start
```

The key store JSON format (`TAVILY_KEY_STORE_PATH`):

```json
{
  "authKey": "your-management-key",
  "keys": [
    { "key": "tvly-xxxxxxxxxxxx", "credit": 1000 },
    { "key": "tvly-yyyyyyyyyyyy", "credit": 1000 }
  ]
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TAVILY_PORT` | `9100` | Server listen port |
| `TAVILY_STORE_PATH` | `~/.local/state/tavily/key-store.json` | Runtime key pool state file |
| `TAVILY_KEY_STORE_PATH` | *(none)* | Initial key + authKey JSON (loaded once at startup) |
| `TAVILY_AUTH_KEY` | *(none)* | Management auth key (x-api-key header). Falls back to `authKey` in key store |
| `TAVILY_EXTERNAL_PATH` | *(none)* | URL path prefix for reverse proxy setups (e.g. `/tavily`) |

## MCP Integration

### OpenCode / Streamable HTTP clients

```json
{
  "mcpServers": {
    "tavily-proxy": {
      "url": "http://localhost:9100/mcp",
      "headers": { "x-api-key": "your-management-key" }
    }
  }
}
```

### Claude Code / Legacy SSE clients

```json
{
  "mcpServers": {
    "tavily-proxy": {
      "url": "http://localhost:9100/sse",
      "headers": { "x-api-key": "your-management-key" }
    }
  }
}
```

## REST API

All REST endpoints accept `api_key` in the request body (or `Authorization: Bearer` header) instead of `x-api-key`:

```bash
# Search
curl -X POST http://localhost:9100/search \
  -H "Content-Type: application/json" \
  -d '{"api_key": "your-management-key", "query": "test"}'

# Extract
curl -X POST http://localhost:9100/extract \
  -H "Content-Type: application/json" \
  -d '{"api_key": "your-management-key", "urls": ["https://example.com"]}'
```

## Key Management CLI

```bash
tavily-cli status          # Show service status and keys
tavily-cli add tvly-xxx    # Add a key
tavily-cli remove tvly-xxx # Remove a key
tavily-cli list            # List keys with remaining credits
tavily-cli health          # Health check
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Development mode (hot reload)
npm run dev

# Type checking
npm run typecheck

# Build
npm run build
```

## Nix

```bash
# Build the package
nix build

# Run directly
nix run

# Enter dev shell
nix develop
```

### Home Manager Module

```nix
# In your flake.nix:
inputs.tavily-proxy.url = "github:pulcerto/tavily-proxy";

# In your Home Manager config:
imports = [ inputs.tavily-proxy.homeManagerModules.default ];

services.tavily-proxy = {
  enable = true;
  port = 9100;
  keyStorePath = "/path/to/decrypted/keys.json";
  externalPath = "/tavily";  # if behind reverse proxy
  afterServices = [ "agenix.service" ];  # if using agenix
};
```

## License

MIT
