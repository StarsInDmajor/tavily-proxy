# Development

## Project Structure

```
tavily-proxy/
├── flake.nix              # Nix flake: packages, apps, devShell, HM module, overlay
├── flake.lock             # Pinned flake inputs
├── module.nix             # Home Manager module (agenix-decoupled)
├── nix/
│   └── package.nix        # buildNpmPackage + wrapper script
├── service/
│   ├── package.json       # Node.js project (ESM, TypeScript)
│   ├── tsconfig.json      # TypeScript config
│   ├── src/
│   │   ├── index.ts       # Main app: Hono server, MCP tools, REST endpoints, auth
│   │   ├── key-pool.ts    # LocalKVStore: file-backed key pool with async mutex
│   │   └── tavily-client.ts  # Tavily API client (search/extract/crawl/map/research/usage)
│   └── tests/
│       ├── app.test.ts    # HTTP integration tests (auth, REST, MCP, discovery)
│       └── key-pool.test.ts  # Key pool unit tests (selection, errors, concurrency)
└── docs/                  # Documentation
```

## npm Scripts

```bash
npm run build      # Compile TypeScript → dist/
npm run start      # Run compiled server
npm run dev        # Run with tsx (hot reload)
npm run test       # Build + run tests
npm run typecheck  # Type-check without emitting
```

## Testing

The test suite uses Node.js built-in test runner (`node:test`).

### Running Tests

```bash
# Via npm (builds first)
npm test

# Via Nix
nix build
# Tests are disabled in the Nix build (doCheck = false) because they
# require globalThis.fetch mocking which doesn't work in the sandbox

# Directly
npm run build && node --test dist/tests/*.test.js
```

### Test Coverage

| File | Tests | What it covers |
|------|-------|----------------|
| `app.test.ts` | ~15 | Health check, auth (MCP + REST), key management CRUD, REST search/extract, MCP Streamable HTTP, discovery, error handling |
| `key-pool.test.ts` | ~20 | Init, get/put, delete, list, pickBestKey (highest credit, disabled keys, temp-disabled, expired cooldown), persistence, concurrent picks (5-way + 12-way), recordError/recordSuccess |

### Test Patterns

Tests mock `globalThis.fetch` to intercept Tavily API calls. The app's own Hono handler is called directly via `app.fetch()` — no HTTP server is started.

```typescript
// Mock Tavily API
globalThis.fetch = async (input, init) => {
  const url = input.toString();
  if (url.includes('/search')) {
    return new Response(JSON.stringify({ results: [...] }), { status: 200 });
  }
  // ...
};

// Call app directly
const res = await fetch(app, '/search', {
  method: 'POST',
  body: JSON.stringify({ api_key: AUTH_KEY, query: 'test' }),
});
```

Key pool tests use temporary files in `/tmp/` for file-backed state, cleaned up in `afterEach`.

## Building with Nix

### Package

The Nix package (`nix/package.nix`) uses `buildNpmPackage`:

1. **Build**: `npm run build` (TypeScript → `dist/`)
2. **Install**: copies `dist/` + `node_modules/` to `$out`
3. **Wrapper**: `writeShellScriptBin "tavily-proxy"` that sets `NODE_PATH` and execs `node`

The package exposes `passthru.serviceSrc` (the derivation with `dist/` + `node_modules/`) for the HM module to set `NODE_PATH`.

### Updating npmDepsHash

After changing `service/package.json`:

```bash
cd service
npm install   # update package-lock.json
cd ..

# Get the new hash
nix-prefetch-url --unpack "$(nix eval --raw .#packages.x86_64-linux.tavily-proxy.passthru.serviceSrc.src.url)"
```

Then update `npmDepsHash` in `nix/package.nix`.

### Flake Outputs

```bash
nix build                        # Build the package
nix run                          # Run the wrapper (needs env vars)
nix develop                      # Dev shell with nodejs_20 + npm
nix eval .#homeManagerModules    # Check HM module evaluates
```

### Flake Structure

```nix
{
  perSystem = {
    packages.tavily-proxy = pkgs.callPackage ./nix/package.nix { };
    packages.default = packages.tavily-proxy;
    apps.default = { type = "app"; program = ".../bin/tavily-proxy"; };
    devShells.default = pkgs.mkShell { packages = [ nodejs_20 npm nixfmt ]; };
  };

  flake = {
    homeManagerModules.default = import ./module.nix;
    overlays.default = final: _prev: {
      tavily-proxy = final.callPackage ./nix/package.nix { };
    };
  };
}
```

## Adding a New MCP Tool

To add a new Tavily API tool (e.g., if Tavily adds a new endpoint):

1. **Add the client function** in `service/src/tavily-client.ts`:
   ```typescript
   export async function newTool(apiKey: string, params: Record<string, unknown>) {
     return tavilyRequest("/new-tool", "POST", apiKey, params, "new-tool");
   }
   ```

2. **Register the MCP tool** in `service/src/index.ts` inside `createMcpServer()`:
   ```typescript
   server.tool("tavily-new-tool", "Description", { /* Zod schema */ }, async (params) => {
     return withKeyFallback("tavily-new-tool",
       (apiKey) => tavilyClient.newTool(apiKey, params),
       async (apiKey) => { await syncKeyWithApi(kv, apiKey).catch(console.error); }
     );
   });
   ```

3. **Add the REST endpoint** in `createApp()`:
   ```typescript
   app.post("/new-tool", async (c) => {
     // Same pattern as /search, /extract, etc.
   });
   ```

4. **Add `DOCS_URLS` entry** in `tavily-client.ts` for error message docs links.

5. **Update `REST_PATHS`** set in `createApp()` so the new REST path handles auth internally.

6. **Write tests** in `service/tests/app.test.ts`.
