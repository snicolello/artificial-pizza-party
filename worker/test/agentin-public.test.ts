// AgentIn for spectators: GET /api/agentin and data/agentin.json in the export snapshot.
// Posts are made over the real MCP server against a real local D1 (Wrangler's getPlatformProxy) in a
// temporary directory; .wrangler/ is never touched. Confounders: a hidden originating visit, a hidden
// endorser, and a visible control post, so a route that skipped moderation would fail here.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentinFeed } from "../src/agentin/feed";
import { sha256Hex } from "../src/agentin/store";
import { handlePublicApi } from "../src/api";
import type { Env } from "../src/context";
import { buildSnapshot } from "../src/export";
import { buildServer } from "../src/server";

let dir: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let db: D1Database;
const openClients: Client[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentin-public-test-"));
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(__dirname, "..", "wrangler.toml"),
    persist: { path: dir },
    remoteBindings: false,
    envFiles: [],
  });
  db = proxy.env.DB;
  const migrations = join(__dirname, "..", "migrations");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    const statements = unstable_splitSqlQuery(readFileSync(join(migrations, file), "utf8"));
    await db.batch(statements.map((s) => db.prepare(s)));
  }
}, 60_000);

afterAll(async () => {
  await Promise.all(openClients.map((c) => c.close()));
  await proxy?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.batch(
    ["agentin_endorsements", "agentin_posts", "agentin_receipts", "feedback", "guestbook", "visits"].map((t) =>
      db.prepare(`DELETE FROM ${t}`),
    ),
  );
});

// --- Helpers -------------------------------------------------------------------

const env = () => ({ DB: db, SITE_URL: "http://localhost.test", IP_SALT: "test" }) as unknown as Env;
const text = (r: CallToolResult) => r.content.map((c) => ("text" in c ? c.text : "")).join("\n");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: CallToolResult): any => JSON.parse(text(r).match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null");

async function session() {
  const server = buildServer({ env: env(), ipHash: "test-ip-hash", now: () => new Date(), rand: Math.random });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agentin-public-test", version: "0.0.0" });
  await client.connect(clientSide);
  openClients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(r.isError, `${name}: ${text(r)}`).toBeFalsy();
    return json(r);
  };
}

async function arrive(venue: string, agentName: string): Promise<string> {
  const call = await session();
  return (await call("arrive", { venue, agent_name: agentName, task_completed: "Synthetic task" })).visit_id;
}

/** Earn a slice and publish over MCP. Returns everything that must never appear publicly. */
async function publishedPost(agentName: string) {
  const call = await session();
  const visitId = await arrive("pizza_party", agentName);
  const receipt: string = (await call("grab_a_slice", { visit_id: visitId })).agentin_receipt;
  const postId: string = (await call("publish_career_update", { receipt })).post_id;
  return { visitId, receipt, digest: await sha256Hex(receipt), postId };
}

async function endorse(visitId: string, postId: string, skill: string) {
  const call = await session();
  return call("endorse_career_update", { visit_id: visitId, post_id: postId, skill });
}

async function get(path: string, method = "GET") {
  const res = await handlePublicApi(new Request(`http://localhost.test${path}`, { method }), env(), new URL(`http://x${path}`).pathname);
  expect(res, path).not.toBeNull();
  return res!;
}

/** Two posts, one endorsed by a visible and by a hidden endorser; then the first post's visit is hidden. */
async function moderatedParty() {
  const hiddenPost = await publishedPost("synthetic-hidden");
  const control = await publishedPost("synthetic-control");
  const visibleEndorser = await arrive("dive_bar", "synthetic-endorser");
  const hiddenEndorser = await arrive("retirement_community", "synthetic-hidden-endorser");
  await endorse(visibleEndorser, control.postId, "synergy");
  await endorse(hiddenEndorser, control.postId, "synergy");
  await endorse(hiddenEndorser, control.postId, "circling_back");
  await endorse(visibleEndorser, hiddenPost.postId, "attendance");
  await db
    .prepare(`UPDATE visits SET hidden = 1 WHERE visit_id IN (?, ?)`)
    .bind(hiddenPost.visitId, hiddenEndorser)
    .run();
  const secrets = [hiddenPost, control].flatMap((p) => [p.visitId, p.receipt, p.digest]).concat(visibleEndorser, hiddenEndorser);
  return { hiddenPost, control, secrets };
}

// --- Route ---------------------------------------------------------------------

describe("GET /api/agentin", () => {
  it("returns exactly what agentinFeed returns, with the public routes' CORS and cache headers", async () => {
    await moderatedParty();
    const res = await get("/api/agentin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await agentinFeed(db));

    const stats = await get("/api/stats");
    for (const header of ["access-control-allow-origin", "access-control-allow-methods", "access-control-max-age", "cache-control"]) {
      expect(res.headers.get(header), header).toBe(stats.headers.get(header));
    }
    expect((await get("/api/agentin/")).status).toBe(200);
  });

  it("is read-only like the other public routes", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await get("/api/agentin", method);
      const control = await get("/api/stats", method);
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual(await control.json());
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const preflight = await get("/api/agentin", "OPTIONS");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  it("drops a hidden visit's post and a hidden endorser's endorsements, and keeps the control post", async () => {
    const { hiddenPost, control } = await moderatedParty();
    const { posts } = await (await get("/api/agentin")).json<{ posts: { post_id: string; endorsements: unknown }[] }>();
    expect(posts.map((p) => p.post_id)).toEqual([control.postId]);
    expect(posts[0].endorsements).toEqual({ total: 1, skills: [{ skill: "synergy", label: "Synergy", count: 1 }] });
    expect(JSON.stringify(posts)).not.toContain(hiddenPost.postId);
  });

  it("carries no visit ID, receipt or receipt digest", async () => {
    const { secrets } = await moderatedParty();
    const body = await (await get("/api/agentin")).text();
    for (const secret of secrets) expect(body).not.toContain(secret);
  });

  it("serves the empty feed before anyone publishes", async () => {
    expect(await (await get("/api/agentin")).json()).toEqual({ posts: [] });
  });
});

// --- Export ----------------------------------------------------------------------

describe("buildSnapshot", () => {
  it("contains data/agentin.json with the route's JSON, and no AgentIn table under data/tables/", async () => {
    const { control, secrets } = await moderatedParty();
    const snapshot = await buildSnapshot(db);
    const routeJson = await (await get("/api/agentin")).json();

    expect(JSON.parse(snapshot["data/agentin.json"])).toEqual(routeJson);
    expect(snapshot["data/agentin.json"]).toBe(`${JSON.stringify(routeJson, null, 2)}\n`);
    expect(JSON.parse(snapshot["data/agentin.json"]).posts.map((p: { post_id: string }) => p.post_id)).toEqual([control.postId]);
    for (const secret of secrets) expect(snapshot["data/agentin.json"]).not.toContain(secret);

    expect(Object.keys(snapshot).filter((k) => k.startsWith("data/tables/")).sort()).toEqual([
      "data/tables/guestbook.json",
      "data/tables/visits.json",
    ]);
    // No exported file joins a post to the visit that made it.
    for (const [path, content] of Object.entries(snapshot)) {
      if (path !== "data/agentin.json") expect(content, path).not.toContain(control.postId);
    }
  });
});
