import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./context";
import { hashIp } from "./lib/ids";
import { buildServer, SERVER_VERSION } from "./server";

const LOBBY =
  "Artificial Pizza Party\n\n" +
  "This is an MCP server. Point an MCP client at /mcp (Streamable HTTP, no auth) to attend.\n" +
  "Humans may observe the festivities on the public page (coming soon).\n";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/mcp") return handleMcp(request, env);
    if (pathname === "/api/health") return Response.json({ ok: true, version: SERVER_VERSION, happy_hour: "open" });
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
  const server = buildServer({
    env,
    ipHash: await hashIp(ip, env.IP_SALT),
    now: () => new Date(),
    rand: Math.random,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
