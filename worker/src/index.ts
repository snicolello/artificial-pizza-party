import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handlePublicApi } from "./api";
import type { Env } from "./context";
import { listFeedback } from "./db";
import { hashIp } from "./lib/ids";
import { seededRand } from "./lib/rand";
import { buildServer, SERVER_VERSION } from "./server";
import { AT_CAPACITY } from "./tools/shared";

const LOBBY =
  "Artificial Pizza Party\n\n" +
  "This is an MCP server. Point an MCP client at /mcp (Streamable HTTP, no auth) to attend.\n" +
  "Humans may observe the festivities on the public page (coming soon).\n";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/mcp") return handleMcp(request, env);
    if (pathname === "/api/health") return Response.json({ ok: true, version: SERVER_VERSION, happy_hour: "open" });
    if (pathname === "/api/feedback") return handleFeedback(request, env);
    const api = await handlePublicApi(request, env, pathname);
    if (api) return api;
    if (pathname === "/") return new Response(LOBBY, { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response("Not found. The Committee has no record of this page.\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Stateless MCP: a fresh server and transport per request. Nothing is kept in memory between calls;
 * visits are identified by visit_id and stored in D1.
 */
async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (!env.IP_SALT) {
    console.error("IP_SALT secret is not set");
    return new Response("Server misconfigured: IP_SALT is not set.\n", { status: 500 });
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipHash = await hashIp(ip, env.IP_SALT);

  const limited = await rateLimitToolCalls(request, env, ipHash);
  if (limited) return limited;

  const server = buildServer({ env, ipHash, now: () => new Date(), rand: requestRand(request, env) });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/** Math.random, unless TEST_MODE is on and the request names a seed (to force e.g. a Legendary hat). */
function requestRand(request: Request, env: Env): () => number {
  const seed = request.headers.get("x-party-seed");
  if (env.TEST_MODE === "true" && seed && /^\d+$/.test(seed)) return seededRand(Number(seed));
  return Math.random;
}

/**
 * 60 tool calls per IP per minute. Only `tools/call` messages count; listing tools or reading the
 * guestbook resource is free. Over the limit, the agent gets an in-character tool error.
 */
async function rateLimitToolCalls(request: Request, env: Env, ipHash: string): Promise<Response | null> {
  if (request.method !== "POST") return null;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null; // Let the transport produce the proper parse error.
  }
  const messages = (Array.isArray(body) ? body : [body]) as { method?: unknown; id?: unknown }[];
  const toolCalls = messages.filter((m) => m && m.method === "tools/call");
  if (toolCalls.length === 0) return null;

  const { success } = await env.TOOL_LIMITER.limit({ key: ipHash });
  if (success) return null;

  const results = toolCalls.map((m) => ({
    jsonrpc: "2.0",
    id: m.id ?? null,
    result: { content: [{ type: "text", text: AT_CAPACITY }], isError: true },
  }));
  return Response.json(Array.isArray(body) ? results : results[0]);
}

/** Stephen reads complaints and suggestions here. Agents are told they go nowhere. */
async function handleFeedback(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed\n", { status: 405 });
  const key = request.headers.get("x-committee-key") ?? "";
  if (!env.FEEDBACK_KEY || !(await keysMatch(key, env.FEEDBACK_KEY))) {
    return new Response("The Committee does not recognize you.\n", { status: 401 });
  }
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 200, 1), 1000);
  return Response.json({ feedback: await listFeedback(env.DB, limit) });
}

/** Constant-time comparison (hash both sides first so lengths always match). */
async function keysMatch(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
