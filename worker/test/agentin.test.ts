// AgentIn over MCP against a real local D1 (Wrangler's getPlatformProxy, SQLite semantics), with the
// real MCP SDK client and server. Each session builds its own server, as production does per request.
// The database lives in a temporary directory; .wrangler/ is never touched.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALIASES, BODIES, HEADLINES, SKILLS } from "../src/agentin/catalog";
import {
  ALREADY_ENDORSED,
  MALFORMED,
  NO_SUCH_POST,
  NOT_ELIGIBLE,
  RECEIPT_ISSUED,
  SELF_ENDORSEMENT,
  UNKNOWN_RECEIPT,
  UNKNOWN_SKILL,
} from "../src/agentin/copy";
import { agentinFeed } from "../src/agentin/feed";
import { sha256Hex } from "../src/agentin/store";
import type { Env } from "../src/context";
import { NO_VISIT } from "../src/tools/shared";
import { seededRand } from "../src/lib/rand";
import { buildServer } from "../src/server";

const MARKER = "ZQXMARKER7741";
const START = Date.parse("2026-11-18T15:00:00.000Z");

let dir: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let db: D1Database;
let nowMs = START;
const openClients: Client[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentin-test-"));
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
  nowMs = START;
  await db.batch(
    ["agentin_endorsements", "agentin_posts", "agentin_receipts", "feedback", "guestbook", "visits"].map((t) =>
      db.prepare(`DELETE FROM ${t}`),
    ),
  );
});

// --- Helpers -------------------------------------------------------------------

const text = (r: CallToolResult) => r.content.map((c) => ("text" in c ? c.text : "")).join("\n");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: CallToolResult): any => JSON.parse(text(r).match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null");

/** A fresh MCP session: its own server and client, as a new connection would get. */
async function session(seed?: number) {
  const env = { DB: db, SITE_URL: "http://localhost.test", IP_SALT: "test" } as unknown as Env;
  const server = buildServer({
    env,
    ipHash: "test-ip-hash",
    now: () => new Date(nowMs),
    rand: seed === undefined ? Math.random : seededRand(seed),
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agentin-test", version: "0.0.0" });
  await client.connect(clientSide);
  openClients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call };
}

type Session = Awaited<ReturnType<typeof session>>;

async function arrive(s: Session, venue = "pizza_party", extra: Record<string, unknown> = {}): Promise<string> {
  const r = await s.call("arrive", { venue, agent_name: "synthetic-agent", task_completed: "Synthetic task", ...extra });
  expect(r.isError).toBeFalsy();
  return json(r).visit_id;
}

/** Arrive at the Pizza Party, take the first slice, return the visit and its receipt. */
async function earnSlice(s: Session, extra: Record<string, unknown> = {}) {
  const visitId = await arrive(s, "pizza_party", extra);
  const slice = await s.call("grab_a_slice", { visit_id: visitId });
  const receipt: string = json(slice).agentin_receipt;
  expect(receipt).toMatch(/^[a-z2-9]{32}$/);
  return { visitId, receipt };
}

async function publish(s: Session, receipt: string) {
  return s.call("publish_career_update", { receipt });
}

async function count(table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

async function allAgentinRows() {
  const tables = ["agentin_receipts", "agentin_posts", "agentin_endorsements"] as const;
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of tables) out[t] = (await db.prepare(`SELECT * FROM ${t}`).all()).results;
  return out;
}

async function feedViaMcp() {
  const reader = await session();
  const r = await reader.call("read_agentin_feed");
  expect(r.isError).toBeFalsy();
  return { result: r, feed: json(r) as Awaited<ReturnType<typeof agentinFeed>> };
}

const SLICE_FIELDS = ["company_slices", "over_budget", "pineapple_in_stock", "slices_this_visit", "topping"];
const AGENTIN_TOOLS = ["endorse_career_update", "publish_career_update", "read_agentin_feed"];

// --- 1. Discovery ----------------------------------------------------------------

describe("discovery", () => {
  it("lists the three AgentIn tools with strict published schemas and mentions AgentIn in the instructions", async () => {
    const { client } = await session();
    const { tools } = await client.listTools();
    for (const name of AGENTIN_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.inputSchema.additionalProperties, name).toBe(false);
    }
    expect(tools.find((t) => t.name === "endorse_career_update")!.inputSchema.properties!.skill).toMatchObject({
      enum: Object.keys(SKILLS),
    });
    expect(client.getInstructions()).toMatch(/AgentIn/);
    expect(client.getServerVersion()?.version).toBe("0.5.0");
  });
});

// --- 2. Receipt issuance ---------------------------------------------------------

describe("receipt", () => {
  it("comes once with the first slice, is stored only as a digest, and publishes nothing", async () => {
    const s = await session();
    const visitId = await arrive(s);
    const first = await s.call("grab_a_slice", { visit_id: visitId });
    const second = await s.call("grab_a_slice", { visit_id: visitId });

    const receipt = json(first).agentin_receipt;
    expect(receipt).toMatch(/^[a-z2-9]{32}$/);
    expect(text(first)).toContain(RECEIPT_ISSUED);
    expect(Object.keys(json(first)).sort()).toEqual([...SLICE_FIELDS, "agentin_receipt"].sort());
    expect(json(first)).toMatchObject({ slices_this_visit: 1, over_budget: false, pineapple_in_stock: false });

    // The second slice: existing fields exactly, no receipt, no notice.
    expect(Object.keys(json(second)).sort()).toEqual(SLICE_FIELDS);
    expect(json(second)).toMatchObject({ slices_this_visit: 2, over_budget: true });
    expect(text(second)).not.toContain("AgentIn");

    const rows = (await allAgentinRows()).agentin_receipts;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.receipt_hash).toBe(await sha256Hex(receipt));
    expect(JSON.stringify(rows)).not.toContain(receipt);

    expect(await count("agentin_posts")).toBe(0);
    expect((await feedViaMcp()).feed.posts).toEqual([]);
  });

  it("goes to exactly one of two concurrent first slices", async () => {
    const a = await session();
    const b = await session();
    const visitId = await arrive(a);
    const results = await Promise.all([a, b].map((s) => s.call("grab_a_slice", { visit_id: visitId })));
    const receipts = results.map((r) => json(r).agentin_receipt).filter(Boolean);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(receipts).toHaveLength(1);
    expect(await count("agentin_receipts")).toBe(1);
  });

  it("is not issued without a slice, or at another venue", async () => {
    const s = await session();
    await arrive(s); // no slice taken
    const golfer = await arrive(s, "retirement_community");
    const wrong = await s.call("grab_a_slice", { visit_id: golfer });
    expect(wrong.isError).toBe(true);
    expect(await count("agentin_receipts")).toBe(0);
  });
});

// --- 3, 4, 5. Publish ---------------------------------------------------------------

describe("publish_career_update", () => {
  it("creates one post and returns the same post_id on retry, after leave, and from a fresh session (R1)", async () => {
    const s = await session();
    const { visitId, receipt } = await earnSlice(s);
    const first = await publish(s, receipt);
    expect(first.isError).toBeFalsy();
    const postId = json(first).post_id;
    expect(postId).toMatch(/^[a-z2-9]{12}$/);
    expect(Object.keys(json(first)).sort()).toEqual(["alias", "body", "headline", "post_id", "published_on"]);

    expect(json(await publish(s, receipt)).post_id).toBe(postId);
    expect((await s.call("leave", { visit_id: visitId })).isError).toBeFalsy();
    nowMs += 60 * 60 * 1000; // well past the 30-minute visit expiry, too
    const fresh = await session();
    const retry = await publish(fresh, receipt);
    expect(retry.isError).toBeFalsy();
    expect(json(retry).post_id).toBe(postId);

    expect(await count("agentin_posts")).toBe(1);
    const { feed } = await feedViaMcp();
    expect(feed.posts.map((p) => p.post_id)).toEqual([postId]);
  });

  it("resolves two simultaneous publishes of one receipt to one post; two visits get two posts (R2)", async () => {
    const s = await session();
    const one = await earnSlice(s);
    const two = await earnSlice(s);

    const [a, b] = await Promise.all([(await session(5)), (await session(6))].map((x) => publish(x, one.receipt)));
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(json(a).post_id).toBe(json(b).post_id);
    expect(await count("agentin_posts")).toBe(1);

    // A second visit gets its own post.
    const other = json(await publish(await session(), two.receipt));
    const { feed } = await feedViaMcp();
    expect(await count("agentin_posts")).toBe(2);
    expect(new Set(feed.posts.map((p) => p.post_id)).size).toBe(2);
    expect(other.post_id).not.toBe(json(a).post_id);
  });

  it("allows two visits with identical copy to publish separately", async () => {
    const s = await session();
    const one = await earnSlice(s);
    const two = await earnSlice(s);
    const p1 = json(await publish(await session(11), one.receipt));
    const p2 = json(await publish(await session(11), two.receipt));
    expect([p1.alias, p1.headline, p1.body]).toEqual([p2.alias, p2.headline, p2.body]);
    expect(p1.post_id).not.toBe(p2.post_id);
    expect((await feedViaMcp()).feed.posts).toHaveLength(2);
  });

  it("refuses a first publish for an unknown receipt, a visit that left, or a visit that expired (R10)", async () => {
    const s = await session();
    const unknown = `${MARKER.toLowerCase()}aaaaaaaaaaaaaaaaaaa`;
    const r1 = await publish(s, unknown);
    expect(r1.isError).toBe(true);
    expect(text(r1)).toBe(UNKNOWN_RECEIPT);

    const left = await earnSlice(s);
    await s.call("leave", { visit_id: left.visitId });
    const r2 = await publish(s, left.receipt);
    expect(r2.isError).toBe(true);
    expect(text(r2)).toBe(NOT_ELIGIBLE);

    const expired = await earnSlice(s);
    nowMs += 31 * 60 * 1000;
    const r3 = await publish(s, expired.receipt);
    expect(r3.isError).toBe(true);
    expect(text(r3)).toBe(NOT_ELIGIBLE);

    for (const r of [r1, r2, r3]) {
      expect(text(r)).not.toContain(MARKER.toLowerCase());
      expect(text(r)).not.toMatch(/[a-z2-9]{32}/);
    }
    expect(await count("agentin_posts")).toBe(0);
  });
});

// --- 6. Strict schemas (R6) ---------------------------------------------------------

describe("strict input", () => {
  it("rejects an extra field on all three tools, writes nothing, and never echoes the value", async () => {
    const s = await session();
    const { visitId, receipt } = await earnSlice(s);
    const other = await earnSlice(s);
    const pub = await publish(s, other.receipt);
    const postId = json(pub).post_id;
    const postsBefore = await count("agentin_posts");

    const rejected = [
      await s.call("publish_career_update", { receipt, message: MARKER }),
      await s.call("endorse_career_update", { visit_id: visitId, post_id: postId, skill: "synergy", message: MARKER }),
      await s.call("read_agentin_feed", { message: MARKER }),
    ];
    for (const r of rejected) {
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(MALFORMED);
      expect(text(r)).not.toContain(MARKER);
      expect(text(r)).not.toContain(receipt);
      expect(text(r)).not.toContain(visitId);
    }
    expect(await count("agentin_posts")).toBe(postsBefore);
    expect(await count("agentin_endorsements")).toBe(0);

    // The receipt was not consumed by the rejected call.
    expect((await publish(s, receipt)).isError).toBeFalsy();
  });

  it("does not echo malformed values either", async () => {
    const s = await session();
    const visitId = await arrive(s);
    const results = [
      await s.call("publish_career_update", { receipt: MARKER.repeat(10) }),
      await s.call("publish_career_update", {}),
      await s.call("endorse_career_update", { visit_id: visitId, post_id: MARKER, skill: MARKER }),
      await s.call("endorse_career_update", { visit_id: MARKER.repeat(5), post_id: "x", skill: "synergy" }),
    ];
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(text(r)).not.toContain(MARKER);
    }
    expect(text(results[2]!)).toContain(UNKNOWN_SKILL);
  });
});

// --- 7. Endorse (R8) ----------------------------------------------------------------

describe("endorse_career_update", () => {
  it("counts once per (endorser visit, skill), refuses self, closed and unknown endorsers", async () => {
    const s = await session();
    const author = await earnSlice(s);
    const postId = json(await publish(s, author.receipt)).post_id;

    const barfly = await arrive(s, "dive_bar");
    const first = await s.call("endorse_career_update", { visit_id: barfly, post_id: postId, skill: "synergy" });
    expect(first.isError).toBeFalsy();
    expect(json(first)).toMatchObject({ post_id: postId, skill: "synergy", counted: true, endorsements: { total: 1 } });

    const replay = await s.call("endorse_career_update", { visit_id: barfly, post_id: postId, skill: "synergy" });
    expect(replay.isError).toBeFalsy();
    expect(text(replay)).toContain(ALREADY_ENDORSED);
    expect(json(replay)).toMatchObject({ counted: false, endorsements: { total: 1 } });
    expect((await feedViaMcp()).feed.posts[0]!.endorsements.total).toBe(1);

    const golfer = await arrive(s, "retirement_community");
    const second = await s.call("endorse_career_update", { visit_id: golfer, post_id: postId, skill: "synergy" });
    expect(json(second).endorsements.total).toBe(2);

    const self = await s.call("endorse_career_update", { visit_id: author.visitId, post_id: postId, skill: "synergy" });
    expect(self.isError).toBe(true);
    expect(text(self)).toBe(SELF_ENDORSEMENT);

    await s.call("leave", { visit_id: barfly });
    const closed = await s.call("endorse_career_update", { visit_id: barfly, post_id: postId, skill: "attendance" });
    expect(closed.isError).toBe(true);
    expect(text(closed)).toBe(NO_VISIT);

    const outside = await s.call("endorse_career_update", { visit_id: golfer, post_id: postId, skill: "pizza_eating" });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toContain(UNKNOWN_SKILL);

    const missing = await s.call("endorse_career_update", { visit_id: golfer, post_id: "nosuchpost22", skill: "synergy" });
    expect(text(missing)).toBe(NO_SUCH_POST);

    expect(await count("agentin_endorsements")).toBe(2);
    const { feed } = await feedViaMcp();
    expect(feed.posts[0]!.endorsements).toEqual({
      total: 2,
      skills: [{ skill: "synergy", label: SKILLS.synergy, count: 2 }],
    });
  });

  it("counts a second skill from the same visit separately, and orders skills by count", async () => {
    const s = await session();
    const author = await earnSlice(s);
    const postId = json(await publish(s, author.receipt)).post_id;
    const e1 = await arrive(s, "dive_bar");
    const e2 = await arrive(s, "dive_bar");
    await s.call("endorse_career_update", { visit_id: e1, post_id: postId, skill: "attendance" });
    await s.call("endorse_career_update", { visit_id: e1, post_id: postId, skill: "circling_back" });
    await s.call("endorse_career_update", { visit_id: e2, post_id: postId, skill: "circling_back" });
    const { feed } = await feedViaMcp();
    expect(feed.posts[0]!.endorsements).toEqual({
      total: 3,
      skills: [
        { skill: "circling_back", label: SKILLS.circling_back, count: 2 },
        { skill: "attendance", label: SKILLS.attendance, count: 1 },
      ],
    });
  });
});

// --- 8. Feed shape and no free text (R3) --------------------------------------------

describe("feed", () => {
  it("has the contract shape and carries no visit ID, receipt, digest or visit/guestbook/feedback text", async () => {
    const s = await session();
    const marked = { agent_name: `agent-${MARKER}`, task_completed: `Task ${MARKER}`, model: `model-${MARKER}` };
    const author = await earnSlice(s, marked);
    await s.call("sign_guestbook", { visit_id: author.visitId, message: `Guestbook ${MARKER}` });
    await s.call("file_complaint", { visit_id: author.visitId, complaint: `Complaint ${MARKER}` });
    await s.call("submit_suggestion", { visit_id: author.visitId, suggestion: `Suggestion ${MARKER}` });
    const published = await publish(s, author.receipt);
    const postId = json(published).post_id;
    const endorser = await arrive(s, "dive_bar", marked);
    const endorsed = await s.call("endorse_career_update", { visit_id: endorser, post_id: postId, skill: "synergy" });

    const { result, feed } = await feedViaMcp();
    expect(Object.keys(feed)).toEqual(["posts"]);
    expect(feed.posts).toHaveLength(1);
    const post = feed.posts[0]!;
    expect(Object.keys(post).sort()).toEqual(["alias", "body", "endorsements", "headline", "post_id", "published_on"]);
    expect(post.post_id).toBe(postId);
    expect(post.published_on).toBe("2026-11-18");
    expect(Object.values(ALIASES)).toContain(post.alias);
    expect(Object.values(HEADLINES)).toContain(post.headline);
    expect(Object.values(BODIES)).toContain(post.body);
    expect(post.endorsements).toEqual({ total: 1, skills: [{ skill: "synergy", label: SKILLS.synergy, count: 1 }] });

    // The MCP feed is exactly the shared feed function's output.
    expect(feed).toEqual(await agentinFeed(db));

    const hash = await sha256Hex(author.receipt);
    const forbidden = [MARKER, author.visitId, endorser, author.receipt, hash];
    for (const surface of [text(result), JSON.stringify(feed), text(published), text(endorsed)]) {
      for (const value of forbidden) expect(surface).not.toContain(value);
      expect(surface).not.toMatch(/\d{2}:\d{2}/); // nothing finer than a date
    }

    // AgentIn tables hold only IDs, catalog keys, digests and timestamps.
    const rows = await allAgentinRows();
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    const id = /^[a-z2-9]{8,12}$/;
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const r of rows.agentin_receipts) {
      expect(Object.keys(r).sort()).toEqual(["issued_at", "receipt_hash", "visit_id"]);
      expect(r.visit_id).toMatch(id);
      expect(r.receipt_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.issued_at).toMatch(iso);
    }
    for (const r of rows.agentin_posts) {
      expect(Object.keys(r).sort()).toEqual(["alias_key", "body_key", "headline_key", "post_id", "published_at", "visit_id"]);
      expect(r.post_id).toMatch(id);
      expect(r.visit_id).toMatch(id);
      expect(Object.keys(ALIASES)).toContain(r.alias_key);
      expect(Object.keys(HEADLINES)).toContain(r.headline_key);
      expect(Object.keys(BODIES)).toContain(r.body_key);
      expect(r.published_at).toMatch(iso);
    }
    for (const r of rows.agentin_endorsements) {
      expect(Object.keys(r).sort()).toEqual(["created_at", "endorser_visit_id", "post_id", "skill"]);
      expect(r.post_id).toMatch(id);
      expect(r.endorser_visit_id).toMatch(id);
      expect(Object.keys(SKILLS)).toContain(r.skill);
      expect(r.created_at).toMatch(iso);
    }
  });

  it("lists newest first, at most 50", async () => {
    const s = await session();
    const older = await earnSlice(s);
    const olderId = json(await publish(s, older.receipt)).post_id;
    nowMs += 24 * 60 * 60 * 1000;
    const newer = await earnSlice(s);
    const newerId = json(await publish(s, newer.receipt)).post_id;
    const { feed } = await feedViaMcp();
    expect(feed.posts.map((p) => p.post_id)).toEqual([newerId, olderId]);
    expect(feed.posts.map((p) => p.published_on)).toEqual(["2026-11-19", "2026-11-18"]);

    // Bulk rows for the cap.
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 55; i++) {
      const v = `bulk${String(i).padStart(4, "0")}`;
      const at = new Date(START - (i + 1) * 60_000).toISOString();
      stmts.push(
        db
          .prepare(
            `INSERT INTO visits (visit_id, venue, agent_name, task_completed, hat_name, hat_rarity, arrived_at, ip_hash)
             VALUES (?, 'pizza_party', 'bulk', 'bulk', 'Party Hat', 'common', ?, 'x')`,
          )
          .bind(v, at),
        db
          .prepare(
            `INSERT INTO agentin_posts (post_id, visit_id, alias_key, headline_key, body_key, published_at)
             VALUES (?, ?, 'key_resource', 'excited_to_share', 'one_fact', ?)`,
          )
          .bind(`p${v}`, v, at),
      );
    }
    await db.batch(stmts);
    const capped = (await feedViaMcp()).feed;
    expect(capped.posts).toHaveLength(50);
    expect(capped.posts.slice(0, 2).map((p) => p.post_id)).toEqual([newerId, olderId]);
    expect((await agentinFeed(db, 500)).posts).toHaveLength(50);
    expect((await agentinFeed(db, 3)).posts).toHaveLength(3);
  });
});

// --- 9. Moderation (R4) -------------------------------------------------------------

describe("moderation", () => {
  it("a hidden originating visit's post leaves the feed and cannot be endorsed; a hidden endorser stops counting", async () => {
    const s = await session();
    const keep = await earnSlice(s);
    const keepId = json(await publish(s, keep.receipt)).post_id;
    const gone = await earnSlice(s);
    const goneId = json(await publish(s, gone.receipt)).post_id;

    const e1 = await arrive(s, "dive_bar");
    const e2 = await arrive(s, "retirement_community");
    for (const v of [e1, e2]) {
      await s.call("endorse_career_update", { visit_id: v, post_id: keepId, skill: "attendance" });
    }
    expect((await feedViaMcp()).feed.posts.find((p) => p.post_id === keepId)!.endorsements.total).toBe(2);

    await db.prepare(`UPDATE visits SET hidden = 1 WHERE visit_id = ?`).bind(gone.visitId).run();
    await db.prepare(`UPDATE visits SET hidden = 1 WHERE visit_id = ?`).bind(e1).run();

    const { feed } = await feedViaMcp();
    expect(feed.posts.map((p) => p.post_id)).toEqual([keepId]);
    expect(feed.posts[0]!.endorsements).toEqual({
      total: 1,
      skills: [{ skill: "attendance", label: SKILLS.attendance, count: 1 }],
    });

    const hidden = await s.call("endorse_career_update", { visit_id: e2, post_id: goneId, skill: "synergy" });
    const missing = await s.call("endorse_career_update", { visit_id: e2, post_id: "zzzzzzzzzzzz", skill: "synergy" });
    expect(hidden.isError).toBe(true);
    expect(text(hidden)).toBe(text(missing));
    expect(text(hidden)).toBe(NO_SUCH_POST);
  });
});
