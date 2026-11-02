import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import * as tavilyClient from "./tavily-client.js";
import { LocalKVStore, createLocalKV, KeyInfo, syncKeyWithApi } from "./key-pool.js";

export { LocalKVStore };

/** Timing-safe string comparison. Returns false if lengths differ. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface Env {
  AUTH_KEY: string;
  PORT: number;
  STORE_PATH: string;
}

export function createApp(kv: LocalKVStore, env: Env) {
  const app = new Hono();

  // REST API paths handle auth internally (api_key in body)
  const REST_PATHS = new Set(["/search", "/extract", "/crawl", "/map", "/research"]);

  // In-memory map from research request_id to the pool API key that initiated it
  const researchKeyMap = new Map<string, string>();

  app.use("*", async (c, next) => {
    if (c.req.path === "/" && c.req.method === "GET") {
      return next();
    }
    if (REST_PATHS.has(c.req.path) || c.req.path.startsWith("/research/")) {
      return next();
    }
    if (c.req.path === "/.well-known/mcp" && c.req.method === "GET") {
      return next();
    }

    const provided = c.req.header("x-api-key");
    if (!provided || !safeEqual(provided, env.AUTH_KEY)) {
      return c.json({ error: "Unauthorized: invalid or missing x-api-key header" }, 401);
    }

    return next();
  });

  function getRestAuthKey(body: Record<string, unknown>, authHeader: string | undefined, xApiKey: string | undefined): string | null {
    if (typeof body.api_key === "string") return body.api_key;
    if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
    if (xApiKey) return xApiKey;
    return null;
  }

  async function withKeyFallbackRaw(
    toolName: string,
    fn: (apiKey: string) => Promise<unknown>,
    postSuccess: (apiKey: string) => Promise<void>
  ): Promise<unknown> {
    const triedKeys = new Set<string>();

    while (true) {
      const pickResult = await kv.pickBestKey();
      if (!pickResult || triedKeys.has(pickResult.apiKey)) {
        throw new Error("No available API keys in the pool. Please add keys first.");
      }
      const apiKey = pickResult.apiKey;
      triedKeys.add(apiKey);
      console.log(`[REST] ${toolName} using key: ${apiKey.substring(0, 13)}...`);
      try {
        const result = await fn(apiKey);
        await kv.updateLastRequestTime(apiKey);
        await kv.recordSuccess(apiKey).catch(console.error);
        await postSuccess(apiKey);
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/Tavily API error (401|403)/.test(message)) {
          console.error(`[REST] ${toolName} key ${apiKey.substring(0, 13)}... got auth error, invalidating and retrying`);
          await kv.put(apiKey, "-1000");
          continue;
        }
        await kv.recordError(apiKey).catch(console.error);
        throw err;
      }
    }
  }

  async function withKeyFallback(
    toolName: string,
    fn: (apiKey: string) => Promise<unknown>,
    postSuccess: (apiKey: string) => Promise<void>
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    const triedKeys = new Set<string>();

    while (true) {
      const pickResult = await kv.pickBestKey();
      if (!pickResult || triedKeys.has(pickResult.apiKey)) {
        return {
          content: [{ type: "text", text: "Error: No available API keys in the pool. Please add keys first." }],
          isError: true,
        };
      }
      const apiKey = pickResult.apiKey;
      triedKeys.add(apiKey);
      if (pickResult.wasRateLimited) {
        console.log(`[MCP] ${toolName} using key after QPS wait: ${apiKey.substring(0, 13)}...`);
      } else {
        console.log(`[MCP] ${toolName} using key: ${apiKey.substring(0, 13)}...`);
      }
      try {
        const result = await fn(apiKey);
        await kv.updateLastRequestTime(apiKey);
        await kv.recordSuccess(apiKey).catch(console.error);
        await postSuccess(apiKey);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/Tavily API error (401|403)/.test(message)) {
          console.error(`[MCP] ${toolName} key ${apiKey.substring(0, 13)}... got auth error, invalidating and retrying`);
          await kv.put(apiKey, "-1000");
          continue;
        }
        await kv.recordError(apiKey).catch(console.error);
        return {
          content: [{ type: "text", text: `Error calling Tavily ${toolName}: ${message}` }],
          isError: true,
        };
      }
    }
  }

  function createMcpServer(): McpServer {
    const server = new McpServer({
      name: "tavily-proxy",
      version: "1.0.0",
    });

    server.tool(
      "tavily-search",
      "A powerful web search tool that provides comprehensive, real-time results using Tavily's AI search engine.",
      {
        query: z.string().describe("The search query to execute with Tavily."),
        search_depth: z
          .enum(["advanced", "basic", "fast", "ultra-fast"])
          .optional()
          .default("basic"),
        topic: z
          .enum(["general", "news", "finance"])
          .optional()
          .default("general"),
        max_results: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .default(5),
        time_range: z
          .enum(["day", "week", "month", "year", "d", "w", "m", "y"])
          .optional(),
        include_answer: z
          .union([z.boolean(), z.enum(["basic", "advanced"])])
          .optional()
          .default(false),
        include_raw_content: z
          .union([z.boolean(), z.enum(["markdown", "text"])])
          .optional()
          .default(false),
        include_images: z
          .boolean()
          .optional()
          .default(false),
        include_image_descriptions: z
          .boolean()
          .optional()
          .default(false),
        include_domains: z
          .array(z.string())
          .optional(),
        exclude_domains: z
          .array(z.string())
          .optional(),
        chunks_per_source: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional(),
        country: z
          .string()
          .optional(),
        start_date: z
          .string()
          .optional()
          .describe("Include results after this date (YYYY-MM-DD)."),
        end_date: z
          .string()
          .optional()
          .describe("Include results before this date (YYYY-MM-DD)."),
        include_favicon: z
          .boolean()
          .optional()
          .default(false),
      },
      async (params) => {
        // Align with official Tavily MCP: country forces topic=general
        if (params.country) params.topic = "general" as typeof params.topic;
        // start_date/end_date and time_range are mutually exclusive
        if ((params.start_date || params.end_date) && params.time_range) {
          params.time_range = undefined;
        }
        return withKeyFallback("tavily-search",
          (apiKey) => tavilyClient.search(apiKey, params),
          async (apiKey) => {
            await syncKeyWithApi(kv, apiKey).catch(console.error);
          }
        );
      }
    );

    server.tool(
      "tavily-extract",
      "Extract web page content from one or more specified URLs.",
      {
        urls: z
          .union([z.string(), z.array(z.string())])
          .describe("A single URL or list of URLs to extract content from."),
        query: z
          .string()
          .optional()
          .describe("User intent for reranking extracted content chunks."),
        extract_depth: z
          .enum(["basic", "advanced"])
          .optional()
          .default("basic"),
        include_images: z
          .boolean()
          .optional()
          .default(false),
        format: z
          .enum(["markdown", "text"])
          .optional()
          .default("markdown"),
        chunks_per_source: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional(),
        include_favicon: z
          .boolean()
          .optional()
          .default(false),
      },
      async (params) => {
        return withKeyFallback("tavily-extract",
          (apiKey) => tavilyClient.extract(apiKey, params),
          async (apiKey) => {
            await syncKeyWithApi(kv, apiKey).catch(console.error);
          }
        );
      }
    );

    server.tool(
      "tavily-crawl",
      "A graph-based website traversal tool that explores hundreds of paths in parallel.",
      {
        url: z.string().describe("The root URL to begin the crawl."),
        instructions: z
          .string()
          .optional()
          .describe("Natural language instructions for the crawler."),
        max_depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .default(1),
        max_breadth: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(20),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(50),
        select_paths: z
          .array(z.string())
          .optional(),
        select_domains: z
          .array(z.string())
          .optional(),
        exclude_paths: z
          .array(z.string())
          .optional(),
        exclude_domains: z
          .array(z.string())
          .optional(),
        allow_external: z
          .boolean()
          .optional()
          .default(true),
        include_images: z
          .boolean()
          .optional()
          .default(false),
        extract_depth: z
          .enum(["basic", "advanced"])
          .optional()
          .default("basic"),
        format: z
          .enum(["markdown", "text"])
          .optional()
          .default("markdown"),
        chunks_per_source: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional(),
        include_favicon: z
          .boolean()
          .optional()
          .default(false),
      },
      async (params) => {
        return withKeyFallback("tavily-crawl",
          (apiKey) => tavilyClient.crawl(apiKey, params),
          async (apiKey) => {
            await syncKeyWithApi(kv, apiKey).catch(console.error);
          }
        );
      }
    );

    server.tool(
      "tavily-map",
      "Traverses websites like a graph to generate comprehensive site maps.",
      {
        url: z.string().describe("The root URL to begin the mapping."),
        instructions: z
          .string()
          .optional()
          .describe("Natural language instructions for the mapper."),
        max_depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .default(1),
        max_breadth: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(20),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(50),
        select_paths: z
          .array(z.string())
          .optional(),
        select_domains: z
          .array(z.string())
          .optional(),
        exclude_paths: z
          .array(z.string())
          .optional(),
        exclude_domains: z
          .array(z.string())
          .optional(),
        allow_external: z
          .boolean()
          .optional()
          .default(true),
      },
      async (params) => {
        return withKeyFallback("tavily-map",
          (apiKey) => tavilyClient.map(apiKey, params),
          async (apiKey) => {
            await syncKeyWithApi(kv, apiKey).catch(console.error);
          }
        );
      }
    );

    server.tool(
      "tavily-research",
      "Deep multi-source research synthesis. Runs an async research job that gathers, reads, and synthesises sources into a comprehensive report with citations. Blocking — polls until complete (30–120s typical). Costs 4–250 credits depending on scope.",
      {
        input: z.string().describe("The research question or topic to investigate."),
        model: z
          .enum(["mini", "pro", "auto"])
          .optional()
          .default("auto")
          .describe("Research model. 'mini' is faster and cheaper; 'pro' is deeper."),
        citation_format: z
          .enum(["numbered", "mla", "apa", "chicago"])
          .optional()
          .default("numbered"),
        output_schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional JSON schema to structure the output."),
        poll_interval: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(2)
          .describe("Initial seconds between polls (exponential backoff applied)."),
        timeout: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum seconds to wait. Defaults: mini=300, pro/auto=900."),
      },
      async (params) => {
        const { poll_interval, timeout, ...researchParams } = params;
        const model = researchParams.model as string | undefined;

        // Model-based defaults (matching official Tavily MCP)
        const INITIAL_POLL_MS = (poll_interval ?? 2) * 1000;
        const MAX_POLL_MS = 10_000;
        const BACKOFF_FACTOR = 1.5;
        const effectiveTimeout = (timeout ?? (model === "mini" ? 300 : 900)) * 1000;

        const triedKeys = new Set<string>();

        while (true) {
          const pickResult = await kv.pickBestKey();
          if (!pickResult || triedKeys.has(pickResult.apiKey)) {
            return {
              content: [{ type: "text" as const, text: "Error: No available API keys in the pool. Please add keys first." }],
              isError: true,
            };
          }
          const apiKey = pickResult.apiKey;
          triedKeys.add(apiKey);
          console.log(`[MCP] tavily-research using key: ${apiKey.substring(0, 13)}...`);

          try {
            const init = await tavilyClient.research(apiKey, researchParams);
            const requestId = init.request_id;
            console.log(`[MCP] tavily-research job started: ${requestId}`);

            const deadline = Date.now() + effectiveTimeout;
            let currentPollMs = INITIAL_POLL_MS;
            let poll: tavilyClient.ResearchPollResponse;

            while (true) {
              await new Promise((r) => setTimeout(r, currentPollMs));
              poll = await tavilyClient.getResearch(apiKey, requestId);
              console.log(`[MCP] tavily-research ${requestId} status: ${poll.status} (next poll: ${Math.min(currentPollMs * BACKOFF_FACTOR, MAX_POLL_MS)}ms)`);
              if (poll.status === "completed" || poll.status === "failed") break;
              if (Date.now() > deadline) {
                return {
                  content: [{ type: "text" as const, text: `Research timed out after ${effectiveTimeout / 1000}s. Request ID: ${requestId}` }],
                  isError: true,
                };
              }
              currentPollMs = Math.min(currentPollMs * BACKOFF_FACTOR, MAX_POLL_MS);
            }

            await kv.updateLastRequestTime(apiKey);
            await syncKeyWithApi(kv, apiKey).catch(console.error);

            return {
              content: [{ type: "text" as const, text: JSON.stringify(poll, null, 2) }],
              isError: poll.status === "failed",
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (/Tavily API error (401|403)/.test(message)) {
              console.error(`[MCP] tavily-research key ${apiKey.substring(0, 13)}... got auth error, invalidating and retrying`);
              await kv.put(apiKey, "-1000");
              continue;
            }
            await kv.recordError(apiKey).catch(console.error);
            return {
              content: [{ type: "text" as const, text: `Error calling Tavily tavily-research: ${message}` }],
              isError: true,
            };
          }
        }
      }
    );

    return server;
  }

  // === REST API (Tavily-compatible) ===
  app.post("/search", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const provided = getRestAuthKey(body, c.req.header("authorization"), c.req.header("x-api-key"));
    if (!provided || !safeEqual(provided, env.AUTH_KEY)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { api_key: _, ...params } = body;
    try {
      const result = await withKeyFallbackRaw("search",
        (apiKey) => tavilyClient.search(apiKey, params),
        async (apiKey) => {
          await syncKeyWithApi(kv, apiKey).catch(console.error);
        }
      );
      return c.json(result);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/extract", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const provided = getRestAuthKey(body, c.req.header("authorization"), c.req.header("x-api-key"));
    if (!provided || !safeEqual(provided, env.AUTH_KEY)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { api_key: _, ...params } = body;
    try {
      const result = await withKeyFallbackRaw("extract",
        (apiKey) => tavilyClient.extract(apiKey, params),
        async (apiKey) => {
          await syncKeyWithApi(kv, apiKey).catch(console.error);
        }
      );
      return c.json(result);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/crawl", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const provided = getRestAuthKey(body, c.req.header("authorization"), c.req.header("x-api-key"));
    if (!provided || !safeEqual(provided, env.AUTH_KEY)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { api_key: _, ...params } = body;
    try {
      const result = await withKeyFallbackRaw("crawl",
        (apiKey) => tavilyClient.crawl(apiKey, params),
        async (apiKey) => {
          await syncKeyWithApi(kv, apiKey).catch(console.error);
        }
      );
      return c.json(result);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/map", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const provided = getRestAuthKey(body, c.req.header("authorization"), c.req.header("x-api-key"));
    if (!provided || !safeEqual(provided, env.AUTH_KEY)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { api_key: _, ...params } = body;
    try {
      const result = await withKeyFallbackRaw("map",
        (apiKey) => tavilyClient.map(apiKey, params),
        async (apiKey) => {
          await syncKeyWithApi(kv, apiKey).catch(console.error);
        }
      );
      return c.json(result);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/research", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const provided = getRestAuthKey(body, c.req.header("authorization"), c.req.header("x-api-key"));
    if (!provided || !safeEqual(provided, env.AUTH_KEY)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { api_key: _, ...params } = body;
    try {
      const result = await withKeyFallbackRaw("research",
        async (apiKey) => {
          const init = await tavilyClient.research(apiKey, params);
          researchKeyMap.set(init.request_id, apiKey);
          return init;
        },
        async (apiKey) => {
          // Cost is dynamic — sync after completion to update credits
          await syncKeyWithApi(kv, apiKey).catch(console.error);
        }
      ) as tavilyClient.ResearchInitResponse;
      return c.json(result);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/research/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    // GET has no JSON body, so accept the same three credential forms the POST
    // routes do: api_key query param, Authorization: Bearer, or x-api-key.
    // (Previously this route was excluded from REST_PATHS and fell through to
    // the x-api-key-only global middleware, so SDK clients that authenticate
    // with Bearer — e.g. `tvly research` — could not poll their own job.)
    const provided = getRestAuthKey(
      { api_key: c.req.query("api_key") },
      c.req.header("authorization"),
      c.req.header("x-api-key"),
    );
    if (!provided || !safeEqual(provided, env.AUTH_KEY)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const requestApiKey = researchKeyMap.get(requestId);
    try {
      let result: tavilyClient.ResearchPollResponse;
      if (requestApiKey) {
        result = await tavilyClient.getResearch(requestApiKey, requestId);
      } else {
        // Fallback: use best available pool key
        const pickResult = await kv.pickBestKey();
        if (!pickResult) {
          return c.json({ error: "No available API keys in the pool" }, 503);
        }
        result = await tavilyClient.getResearch(pickResult.apiKey, requestId);
      }
      if ((result.status === "completed" || result.status === "failed") && requestApiKey) {
        researchKeyMap.delete(requestId);
        await syncKeyWithApi(kv, requestApiKey).catch(console.error);
      }
      return c.json(result);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // === MCP Transports ===
  // Store SSE transports by session ID (Streamable HTTP manages its own sessions)
  const sseTransports = new Map<string, SSEServerTransport>();

  //=============================================================================
  // STREAMABLE HTTP TRANSPORT (Protocol version 2025-11-25)
  // For OpenCode and modern MCP clients using WebStandardStreamableHTTPServerTransport
  // Stateless mode: new server+transport per request (no session management)
  //=============================================================================

  app.all("/mcp", async (c) => {
    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // Fix: Add default Accept header if missing (required by MCP Streamable HTTP spec)
    // Many MCP clients don't send this header, causing "Not Acceptable" errors
    const req = c.req.raw;
    const acceptHeader = req.headers.get("accept");
    let finalReq = req;
    if (!acceptHeader || (!acceptHeader.includes("application/json") && !acceptHeader.includes("text/event-stream"))) {
      console.log(`[MCP] Adding default Accept header (was: "${acceptHeader}")`);
      const newHeaders = new Headers(req.headers);
      newHeaders.set("accept", "application/json, text/event-stream");
      finalReq = new Request(req.url, {
        method: req.method,
        headers: newHeaders,
        body: req.body,
        redirect: req.redirect,
        signal: req.signal,
        duplex: 'half',
      });
    }

    await server.connect(transport);
    return transport.handleRequest(finalReq);
  });

  //=============================================================================
  // LEGACY SSE TRANSPORT (Protocol version 2024-11-05)
  // For Claude Code and older MCP clients
  //=============================================================================

  app.get("/sse", async (c) => {
    console.log("[SSE] GET /sse - establishing SSE connection");
    const server = createMcpServer();

    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    const mockRes = {
      writeHead: () => mockRes,
      setHeader: () => mockRes,
      write: (chunk: string | Buffer): boolean => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
        writer.write(encoder.encode(text));
        return true;
      },
      end: () => {
        writer.close();
        return mockRes;
      },
      on: () => mockRes,
    };

    const externalPath = process.env.TAVILY_EXTERNAL_PATH ?? "";
    const transport = new SSEServerTransport(`${externalPath}/sse/message`, mockRes as any);
    sseTransports.set(transport.sessionId, transport);

    await server.connect(transport);

    c.req.raw.signal.addEventListener("abort", () => {
      sseTransports.delete(transport.sessionId);
      transport.close();
      server.close();
    });

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  app.post("/sse/message", async (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
      return c.json({ error: "Missing sessionId query parameter" }, 400);
    }

    const transport = sseTransports.get(sessionId);
    if (!transport) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = await c.req.json();
    await transport.handleMessage(body);
    return new Response(null, { status: 202 });
  });

  // === Key Management API ===
  app.post("/api/keys", async (c) => {
    try {
      const body = await c.req.json<{ apiKey: string }>();
      if (!body.apiKey) {
        return c.json({ error: "Missing 'apiKey' in request body" }, 400);
      }
      const remaining = await syncKeyWithApi(kv, body.apiKey);
      return c.json({ success: true, key: { apiKey: body.apiKey, remainingCredit: remaining } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.delete("/api/keys", async (c) => {
    try {
      const body = await c.req.json<{ apiKey: string }>();
      if (!body.apiKey) {
        return c.json({ error: "Missing 'apiKey' in request body" }, 400);
      }
      await kv.delete(body.apiKey);
      return c.json({ success: true, deleted: body.apiKey });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/keys", async (c) => {
    try {
      const keys = await kv.getAllKeys();
      const maskedKeys = keys.map(k => ({
        ...k,
        apiKey: k.apiKey.substring(0, 8) + "...",
      }));
      return c.json({ keys: maskedKeys });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/", (c) => {
    return c.json({
      service: "tavily-proxy",
      version: "1.0.0",
      transports: {
        streamableHttp: {
          protocol: "2025-11-25",
          endpoint: "POST /mcp",
          description: "For OpenCode and modern MCP clients",
        },
        sse: {
          protocol: "2024-11-05",
          endpoints: {
            connect: "GET /sse",
            message: "POST /sse/message?sessionId=xxx",
          },
          description: "For Claude Code and legacy MCP clients",
        },
      },
      restApi: {
        search: "POST /search { api_key, query, ... }",
        extract: "POST /extract { api_key, urls, ... }",
        crawl: "POST /crawl { api_key, url, ... }",
        map: "POST /map { api_key, url, ... }",
        research: "POST /research { api_key, input, ... }",
        researchPoll: "GET /research/:requestId",
      },
      keyManagement: {
        addKey: "POST /api/keys { apiKey: string }",
        deleteKey: "DELETE /api/keys { apiKey: string }",
        listKeys: "GET /api/keys",
      },
    });
  });

  //=============================================================================
  // MCP Server Discovery (/.well-known/mcp)
  // Required by MCP spec for client metadata discovery
  //=============================================================================
  app.get("/.well-known/mcp", (c) => {
    const host = c.req.header("host") || "";
    const protocol = c.req.header("x-forwarded-proto") || "http";
    const baseUrl = `${protocol}://${host}`;
    return c.json({
      mcp_version: "1.0",
      server_name: "tavily-proxy",
      server_version: "1.0.0",
      endpoints: {
        streamable_http: `${baseUrl}/mcp`,
        sse: `${baseUrl}/sse`,
      },
      capabilities: {
        tools: true,
        resources: false,
        prompts: false,
        sampling: false,
        roots: false,
      },
      authentication: {
        required: true,
        methods: ["api_key"],
      },
      documentation: "https://github.com/anthropics/mcp",
    });
  });

  return { app };
}

async function loadInitialKeys(kv: LocalKVStore, keyStorePath: string | null) {
  if (!keyStorePath) {
    console.warn('[startup] No TAVILY_KEY_STORE_PATH configured; starting with empty key pool.');
    return;
  }

  let data: Record<string, unknown>;
  try {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(keyStorePath, 'utf-8');
    data = JSON.parse(content);
  } catch (error) {
    console.error(`[startup] FATAL: key store path is configured (${keyStorePath}) but could not be read:`, error);
    process.exit(1);
  }

  if (data.keys && Array.isArray(data.keys)) {
    console.log(`[startup] Loading ${(data.keys as unknown[]).length} initial keys from ${keyStorePath}`);
    for (const keyEntry of data.keys as Record<string, unknown>[]) {
      const apiKey = (keyEntry.key as string | undefined) || (keyEntry.apiKey as string | undefined);
      if (apiKey) {
        const credit = (keyEntry.credit as number | undefined) || 1000;
        await kv.put(apiKey, String(credit));
        console.log(`[startup]   - Loaded key: ${apiKey.substring(0, 13)}... (credit: ${credit})`);
      }
    }
  }
}

async function main() {
  const port = Number(process.env.TAVILY_PORT) || 9100;
  const storePath = process.env.TAVILY_STORE_PATH || "/home/pulcerto/.local/state/tavily/key-store.json";
  const keyStorePath = process.env.TAVILY_KEY_STORE_PATH || null;

  let authKey = process.env.TAVILY_AUTH_KEY || "";
  if (!authKey && keyStorePath) {
    try {
      const fs = await import('node:fs/promises');
      const data = JSON.parse(await fs.readFile(keyStorePath, 'utf-8'));
      if (typeof data.authKey === "string" && data.authKey) {
        authKey = data.authKey;
        console.log("Loaded authKey from key store file");
      }
    } catch (e) {
      console.warn("Could not read authKey from key store file:", e);
    }
  }
  if (!authKey) {
    console.error("FATAL: no authKey configured. Set TAVILY_AUTH_KEY or add authKey to the key store JSON.");
    process.exit(1);
  }

  console.log(`Starting tavily-proxy standalone on port ${port}`);
  console.log(`Store path: ${storePath}`);

  const kv = createLocalKV(storePath);
  await kv.initialize();

  await loadInitialKeys(kv, keyStorePath);

  const { app } = createApp(kv, { AUTH_KEY: authKey, PORT: port, STORE_PATH: storePath });

  const { serve } = await import("@hono/node-server");

  serve({
    fetch: app.fetch,
    port,
  }, (info) => {
    console.log(`tavily-proxy listening on http://localhost:${info.port}`);
    console.log(`Health check: curl http://localhost:${info.port}/`);
    console.log(``);
    console.log(`MCP Transports:`);
    console.log(`  Streamable HTTP (OpenCode): POST http://localhost:${info.port}/mcp`);
    console.log(`  Legacy SSE (Claude Code):   GET  http://localhost:${info.port}/sse`);
    console.log(``);
    console.log(`Auth: configured`);
  });
}

// Only run main when executed directly, not when imported for testing
if (process.argv[1]?.endsWith('index.js') && !process.env.NODE_TEST_CONTEXT) {
  main().catch(console.error);
}