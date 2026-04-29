# Deployment

## Home Manager Module

The project includes a Nix flake that exports a Home Manager module for declarative deployment.

### Basic Usage

```nix
# In your flake.nix:
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    tavily-proxy.url = "github:StarsInDmajor/tavily-proxy";
  };

  outputs = { nixpkgs, tavily-proxy, ... }@inputs: {
    homeConfigurations."user@host" = nixpkgs.lib.homeManagerConfiguration {
      # ...
      modules = [
        tavily-proxy.homeManagerModules.default
        {
          nixpkgs.overlays = [ tavily-proxy.overlays.default ];
        }
      ];
    };
  };
}
```

The overlay provides `pkgs.tavily-proxy` so the module can find the package.

### Module Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `services.tavily-proxy.enable` | bool | `false` | Enable the service |
| `services.tavily-proxy.package` | package | `pkgs.tavily-proxy` | Package to use (provided by overlay) |
| `services.tavily-proxy.port` | port | `9100` | Listen port |
| `services.tavily-proxy.authKey` | nullOr str | `null` | Management auth key. If `null`, reads `authKey` from key store JSON |
| `services.tavily-proxy.storePath` | nullOr str | `null` | Runtime state file path. Defaults to `~/.local/state/tavily/key-store.json` |
| `services.tavily-proxy.keyStorePath` | nullOr str | `null` | Path to JSON with `authKey` + initial keys (typically an agenix secret) |
| `services.tavily-proxy.externalPath` | str | `""` | URL prefix for reverse proxy (e.g., `/tavily`). Sets `TAVILY_EXTERNAL_PATH` |
| `services.tavily-proxy.autoStart` | bool | `true` | Start the service automatically |
| `services.tavily-proxy.afterServices` | listOf str | `[]` | Additional systemd dependencies (e.g., `[ "agenix.service" ]`) |

### Full Example with Agenix

```nix
{ config, inputs, pkgs, ... }:

{
  imports = [ inputs.tavily-proxy.homeManagerModules.default ];

  nixpkgs.overlays = [ inputs.tavily-proxy.overlays.default ];

  # Decrypt the key store JSON via agenix
  age.secrets.tavily-keys = {
    file = ./secrets/keys/tavily-keys.json.age;
    path = "${config.home.homeDirectory}/.config/secrets/tavily-keys.json";
    mode = "600";
  };

  services.tavily-proxy = {
    enable = true;
    port = 9100;
    keyStorePath = config.age.secrets.tavily-keys.path;
    externalPath = "/tavily";
    afterServices = [ "agenix.service" ];
  };
}
```

### Key Store JSON Format

The file referenced by `keyStorePath`:

```json
{
  "authKey": "your-secret-management-key",
  "keys": [
    { "key": "tvly-xxxxxxxxxxxx", "credit": 1000 },
    { "key": "tvly-yyyyyyyyyyyy", "credit": 1000 }
  ]
}
```

- `authKey` — the management key used to authenticate callers. Required unless `services.tavily-proxy.authKey` is set.
- `keys[].key` — Tavily API key (string starting with `tvly-`). Also accepts `keys[].apiKey`.
- `keys[].credit` — initial credit estimate. The proxy syncs the real value from Tavily's `/usage` endpoint after the first request. If omitted, defaults to `1000`.

### Systemd Service

The module creates `~/.config/systemd/user/tavily-proxy.service`:

```ini
[Unit]
Description=Tavily MCP proxy with API key pool
After=network.target agenix.service
Wants=agenix.service

[Service]
Type=simple
ExecStart=.../bin/tavily-proxy
Restart=on-failure
RestartSec=5s
Environment=TAVILY_PORT=9100
Environment=TAVILY_STORE_PATH=.../key-store.json
Environment=TAVILY_KEY_STORE_PATH=.../tavily-keys.json
Environment=TAVILY_EXTERNAL_PATH=/tavily
Environment=NODE_OPTIONS=--max-old-space-size=64

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.local/state/tavily %h/.config/tavily-proxy
MemoryMax=192M
LimitNPROC=100
LimitNOFILE=1024

[Install]
WantedBy=default.target
```

### Installed Packages

The module adds to `home.packages`:

| Package | Purpose |
|---------|---------|
| `tavily-proxy` | Service wrapper script |
| `tavily-cli` | Key management CLI |
| `jq` | Used by `tavily-cli` to parse JSON responses |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TAVILY_PORT` | `9100` | HTTP listen port |
| `TAVILY_STORE_PATH` | `~/.local/state/tavily/key-store.json` | Runtime key pool state file (file-backed JSON) |
| `TAVILY_KEY_STORE_PATH` | *(none)* | Initial key store JSON (loaded once at startup). Contains `authKey` + `keys` array |
| `TAVILY_AUTH_KEY` | *(none)* | Management auth key. Falls back to `authKey` in key store JSON if not set. **Required** — the process exits if neither is provided |
| `TAVILY_EXTERNAL_PATH` | *(none)* | URL path prefix for the SSE message endpoint. Set to the reverse proxy location (e.g., `/tavily`) when the service is behind a path-based proxy |

---

## Reverse Proxy Setup

When placing the proxy behind nginx (or any reverse proxy) with a path prefix:

### nginx Configuration

```nginx
location /tavily/ {
    proxy_pass http://127.0.0.1:9100/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;

    # SSE support
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 86400s;
}
```

### Module Configuration

Set `externalPath` so the SSE transport advertises the correct message endpoint:

```nix
services.tavily-proxy = {
  enable = true;
  port = 9100;
  externalPath = "/tavily";
  # ...
};
```

This makes the SSE transport send `/tavily/sse/message` as the message endpoint URL instead of `/sse/message`, so clients behind the proxy can reach it.

### MCP Client Configuration (behind proxy)

```json
{
  "mcpServers": {
    "tavily-proxy": {
      "url": "https://example.com/tavily/mcp",
      "headers": { "x-api-key": "your-secret-management-key" }
    }
  }
}
```

---

## CLI: tavily-cli

Installed alongside the service. Reads `authKey` from the key store JSON or `TAVILY_AUTH_KEY` env var.

```bash
tavily-cli status          # Show service info + key list
tavily-cli add tvly-xxx    # Add key (syncs credits from Tavily)
tavily-cli remove tvly-xxx # Remove key
tavily-cli list            # List keys with credits (masked)
tavily-cli health          # HTTP health check (status code only)
```

### Adding a New Key

```bash
tavily-cli add tvly-xxxxxxxxxxxxxxxxxxxxx
```

The proxy calls Tavily's `/usage` endpoint to get the real credit balance and stores it in the key pool.

### Monitoring Key Credits

```bash
tavily-cli list
```

Output:

```
tvly-xxx...  remainingCredit: 850
tvly-yyy...  remainingCredit: 420
```

Credits are synced automatically after each successful request. To force a sync, remove and re-add the key.
