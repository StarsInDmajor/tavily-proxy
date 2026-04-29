import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createApp, LocalKVStore } from '../src/index.js';

const AUTH_KEY = 'test-auth-key-12345';

async function createTestApp(): Promise<{
  app: ReturnType<typeof createApp>['app'];
  kv: LocalKVStore;
  storePath: string;
  cleanup: () => Promise<void>;
}> {
  const storePath = path.join('/tmp', `tavily-app-test-${Date.now()}.json`);
  const kv = new LocalKVStore(storePath);
  await kv.initialize();

  // Pre-load a test API key
  await kv.put('tvly-test-key-1', '1000');

  const { app } = createApp(kv, {
    AUTH_KEY,
    PORT: 0,
    STORE_PATH: storePath,
  });

  return {
    app,
    kv,
    storePath,
    cleanup: async () => {
      await fs.unlink(storePath).catch(() => {});
    },
  };
}

/**
 * Helper: call app.fetch with a Request and return the Response.
 */
function fetch(
  app: ReturnType<typeof createApp>['app'],
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `http://localhost${path}`;
  return Promise.resolve(app.fetch(new Request(url, options)));
}

describe('HTTP Integration Tests', () => {
  let app: ReturnType<typeof createApp>['app'];
  let kv: LocalKVStore;
  let cleanup: () => Promise<void>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    kv = ctx.kv;
    cleanup = ctx.cleanup;

    // Save original fetch and mock it globally for all tests
    originalFetch = globalThis.fetch;
    mockTavilyApi({});
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await cleanup();
  });

  /**
   * Mock globalThis.fetch to intercept Tavily API calls.
   * Calls to localhost (our app) should go through normally — but since
   * we call app.fetch directly, only Tavily API calls will hit globalThis.fetch.
   */
  function mockTavilyApi(responses: Record<string, unknown>) {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      // Mock /search endpoint
      if (url.includes('/search')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        if (body.query === 'mock-search') {
          return new Response(
            JSON.stringify(responses['/search'] ?? { results: [{ title: 'Test', url: 'https://example.com', content: 'mock result' }], query: 'mock-search' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (body.query === 'auth-error') {
          return new Response('Unauthorized', { status: 401 });
        }
        if (body.query === 'server-error') {
          return new Response('Internal Server Error', { status: 500 });
        }
      }

      // Mock /extract endpoint
      if (url.includes('/extract')) {
        return new Response(
          JSON.stringify(responses['/extract'] ?? { results: [{ url: 'https://example.com', raw_content: 'extracted content' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Mock /usage endpoint (for syncKeyWithApi)
      if (url.includes('/usage')) {
        return new Response(
          JSON.stringify({ key: { usage: 100, limit: 1000 }, account: { plan_limit: 1000, plan_usage: 100 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Default: 404
      return new Response(JSON.stringify({ error: 'Not mocked' }), { status: 404 });
    };
  }

  describe('Health check', () => {
    it('GET / returns service info', async () => {
      const res = await fetch(app, '/');
      assert.strictEqual(res.status, 200);

      const body = await res.json() as Record<string, unknown>;
      assert.strictEqual(body.service, 'tavily-proxy');
      assert.strictEqual(body.version, '1.0.0');
      assert.ok(body.transports);
      assert.ok(body.restApi);
      assert.ok(body.keyManagement);
    });
  });

  describe('Authentication', () => {
    it('rejects requests without auth header to /api/keys', async () => {
      const res = await fetch(app, '/api/keys');
      assert.strictEqual(res.status, 401);
    });

    it('rejects requests with wrong auth key', async () => {
      const res = await fetch(app, '/api/keys', {
        headers: { 'x-api-key': 'wrong-key' },
      });
      assert.strictEqual(res.status, 401);
    });

    it('accepts requests with correct auth key', async () => {
      const res = await fetch(app, '/api/keys', {
        headers: { 'x-api-key': AUTH_KEY },
      });
      assert.strictEqual(res.status, 200);
    });

    it('REST /search accepts api_key in body', async () => {
      mockTavilyApi({});
      const res = await fetch(app, '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: AUTH_KEY, query: 'mock-search' }),
      });
      assert.strictEqual(res.status, 200);
    });

    it('REST /search rejects wrong api_key', async () => {
      const res = await fetch(app, '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'wrong-key', query: 'test' }),
      });
      assert.strictEqual(res.status, 401);
    });
  });

  describe('Key Management API', () => {
    it('POST /api/keys adds a new key', async () => {
      const res = await fetch(app, '/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': AUTH_KEY },
        body: JSON.stringify({ apiKey: 'tvly-new-key-abc' }),
      });
      assert.strictEqual(res.status, 200);

      const body = await res.json() as Record<string, unknown>;
      assert.strictEqual(body.success, true);
      assert.ok((body.key as Record<string, unknown>).remainingCredit);
    });

    it('GET /api/keys lists keys (masked)', async () => {
      const res = await fetch(app, '/api/keys', {
        headers: { 'x-api-key': AUTH_KEY },
      });
      assert.strictEqual(res.status, 200);

      const body = await res.json() as Record<string, unknown>;
      const keys = body.keys as Array<Record<string, unknown>>;
      assert.ok(keys.length >= 1);
      // Keys should be masked
      for (const key of keys) {
        const apiKey = key.apiKey as string;
        assert.ok(apiKey.endsWith('...'), `Key should be masked: ${apiKey}`);
      }
    });

    it('DELETE /api/keys removes a key', async () => {
      // Add a key first
      await fetch(app, '/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': AUTH_KEY },
        body: JSON.stringify({ apiKey: 'tvly-to-delete' }),
      });

      // Delete it
      const res = await fetch(app, '/api/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-api-key': AUTH_KEY },
        body: JSON.stringify({ apiKey: 'tvly-to-delete' }),
      });
      assert.strictEqual(res.status, 200);

      const body = await res.json() as Record<string, unknown>;
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.deleted, 'tvly-to-delete');
    });

    it('POST /api/keys requires apiKey in body', async () => {
      const res = await fetch(app, '/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': AUTH_KEY },
        body: JSON.stringify({}),
      });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('REST /search', () => {
    it('returns search results', async () => {
      mockTavilyApi({});

      const res = await fetch(app, '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: AUTH_KEY, query: 'mock-search' }),
      });
      assert.strictEqual(res.status, 200);

      const body = await res.json() as Record<string, unknown>;
      assert.ok(body.results);
    });

    it('returns 401 for wrong api_key', async () => {
      const res = await fetch(app, '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'wrong-key', query: 'test' }),
      });
      assert.strictEqual(res.status, 401);
    });
  });

  describe('REST /extract', () => {
    it('returns extract results', async () => {
      mockTavilyApi({});

      const res = await fetch(app, '/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: AUTH_KEY, urls: ['https://example.com'] }),
      });
      assert.strictEqual(res.status, 200);

      const body = await res.json() as Record<string, unknown>;
      assert.ok(body.results);
    });
  });

  describe('MCP Streamable HTTP', () => {
    it('GET /mcp returns method not allowed or handles gracefully', async () => {
      // Streamable HTTP primarily uses POST, but we verify the endpoint exists
      const res = await fetch(app, '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': AUTH_KEY,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          },
        }),
      });
      // Should get some response (not 404 or 401)
      assert.ok(res.status === 200 || res.status === 202, `Expected 200 or 202, got ${res.status}`);
    });
  });

  describe('MCP Discovery', () => {
    it('GET /.well-known/mcp returns discovery info', async () => {
      const res = await fetch(app, '/.well-known/mcp');
      assert.strictEqual(res.status, 200);

      const body = await res.json() as Record<string, unknown>;
      assert.strictEqual(body.mcp_version, '1.0');
      assert.strictEqual(body.server_name, 'tavily-proxy');
      assert.ok(body.endpoints);
      assert.ok(body.capabilities);
    });
  });

  describe('Error handling', () => {
    it('REST /search returns 500 on Tavily server error', async () => {
      mockTavilyApi({});

      const res = await fetch(app, '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: AUTH_KEY, query: 'server-error' }),
      });
      assert.strictEqual(res.status, 500);

      const body = await res.json() as Record<string, unknown>;
      assert.ok(body.error);
      // Error message should include docs URL
      assert.ok(
        (body.error as string).includes('docs.tavily.com'),
        `Error should include docs URL: ${body.error}`,
      );
    });
  });
});
