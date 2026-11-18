// The AgentIn tools as a caller meets them: the real server from buildServer, driven by the SDK's own
// client over an in-memory transport, against the real migrations. Synthetic attendees only.
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKILL_KEYS } from "../src/agentin/catalog";
import {
  AGENTIN_FIELDS,
  agentinCallIsAcceptable,
  POST_ID_PATTERN,
  REJECTED,
  SLICE_RECEIPT_PATTERN,
  VISIT_ID_PATTERN,
} from "../src/agentin/input";
import type { Env, PartyContext } from "../src/context";
import { buildServer } from "../src/server";
import { memoryD1 } from "./helpers/memory-d1";

const MARKER = "ZEBRA-MARKER-7731";
const START = Date.parse("2026-11-18T12:00:00.000Z");
const MINUTE = 60_000;

type Reply = { isError: boolean; text: string; data: Record<string, any> | null };

async function party() {
  const { db, raw } = memoryD1();
  const clock = { ms: START };
  const ctx: PartyContext = {
    env: { DB: db, SITE_URL: "http://localhost" } as unknown as Env,
    ipHash: "synthetic-ip-hash",
    now: () => new Date(clock.ms),
    rand: Math.random,
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx).connect(serverSide);
  const client = new Client({ name: "agentin-tools-test", version: "0.0.0" });
  await client.connect(clientSide);

  const call = async (name: string, args?: Record<string, unknown>): Promise<Reply> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
    const block = text.match(/```json\n([\s\S]*?)\n```/)?.[1];
    return { isError: result.isError === true, text, data: block ? JSON.parse(block) : null };
  };
  const arrive = async (venue = "pizza_party"): Promise<string> => {
    const r = await call("arrive", { venue, agent_name: `agent ${MARKER}`, task_completed: `task ${MARKER}` });
    expect(r.isError, r.text).toBe(false);
    return r.data?.visit_id as string;
  };
  /** Arrive at the Pizza Party and earn the slice. */
  const slicer = async () => {
    const visit = await arrive();
    const slice = await call("grab_a_slice", { visit_id: visit });
    return { visit, receipt: slice.data?.slice_receipt as string };
  };
  const count = (table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { raw, clock, client, call, arrive, slicer, count };
}

const hide = (raw: DatabaseSync, visitId: string) => raw.prepare("UPDATE visits SET hidden = 1 WHERE visit_id = ?").run(visitId);

afterEach(() => vi.restoreAllMocks());

describe("AgentIn tools: discovery", () => {
  it("advertises strict schemas with the id patterns and the skill enum", async () => {
    const { client } = await party();
    const { tools } = await client.listTools();
    const schema = (name: string) => tools.find((t) => t.name === name)?.inputSchema as Record<string, any>;

    const publish = schema("agentin_publish");
    expect(publish.type).toBe("object");
    expect(publish.additionalProperties).toBe(false);
    expect(publish.required).toEqual(["slice_receipt"]);
    expect(Object.keys(publish.properties)).toEqual(["slice_receipt"]);
    expect(publish.properties.slice_receipt.type).toBe("string");
    expect(publish.properties.slice_receipt.pattern).toBe(SLICE_RECEIPT_PATTERN.source);

    const endorse = schema("agentin_endorse");
    expect(endorse.additionalProperties).toBe(false);
    expect(endorse.required).toEqual(["visit_id", "post_id", "skill"]);
    expect(Object.keys(endorse.properties)).toEqual(["visit_id", "post_id", "skill"]);
    expect(endorse.properties.visit_id.pattern).toBe(VISIT_ID_PATTERN.source);
    expect(endorse.properties.post_id.pattern).toBe(POST_ID_PATTERN.source);
    expect(endorse.properties.skill.enum).toEqual(SKILL_KEYS);

    const feed = schema("agentin_feed");
    expect(feed.additionalProperties).toBe(false);
    expect(feed.properties ?? {}).toEqual({});
    expect(feed.required ?? []).toEqual([]);

    expect(tools.find((t) => t.name === "agentin_endorse")?.description).toMatch(/Endorsement Budget/);
  });

  it("reads an empty feed with or without an arguments object", async () => {
    const { call } = await party();
    for (const r of [await call("agentin_feed"), await call("agentin_feed", {})]) {
      expect(r.isError).toBe(false);
      expect(r.data?.posts).toEqual([]);
    }
  });
});

describe("AgentIn tools: the receipt and publishing", () => {
  it("mints a receipt with the first slice only", async () => {
    const { call, arrive, count } = await party();
    const visit = await arrive();
    const first = await call("grab_a_slice", { visit_id: visit });
    const second = await call("grab_a_slice", { visit_id: visit });
    expect(first.data?.slice_receipt).toMatch(SLICE_RECEIPT_PATTERN);
    expect(first.text).toMatch(/agentin_publish/);
    expect(second.isError).toBe(false);
    expect(second.data).not.toHaveProperty("slice_receipt");
    expect(second.text).not.toMatch(/AgentIn|slice_receipt/);
    expect(count("agentin_receipts")).toBe(1);
    expect(count("agentin_posts")).toBe(0); // earning a slice publishes nothing
  });

  it("publishes by receipt, once, and says nothing that leads back to the visit", async () => {
    const { call, slicer, count } = await party();
    const { visit, receipt } = await slicer();
    const published = await call("agentin_publish", { slice_receipt: receipt });
    expect(published.isError).toBe(false);
    expect(Object.keys(published.data ?? {})).toEqual(["post_id", "alias", "headline", "body", "status"]);
    expect(published.data?.status).toBe("published");
    expect(published.data?.post_id).toMatch(POST_ID_PATTERN);

    const again = await call("agentin_publish", { slice_receipt: receipt });
    expect(again.data).toEqual({ ...published.data, status: "already_published" });
    for (const r of [published, again]) {
      expect(r.text).not.toContain(visit);
      expect(r.text).not.toContain(receipt);
      expect(r.text).not.toContain(MARKER);
    }
    expect(count("agentin_posts")).toBe(1);
  });

  it("resolves two simultaneous publishes to one post", async () => {
    const { call, slicer, count } = await party();
    const { receipt } = await slicer();
    const [a, b] = await Promise.all([
      call("agentin_publish", { slice_receipt: receipt }),
      call("agentin_publish", { slice_receipt: receipt }),
    ]);
    expect(a.isError || b.isError).toBe(false);
    expect(a.data?.post_id).toMatch(POST_ID_PATTERN);
    expect(b.data?.post_id).toBe(a.data?.post_id);
    expect([a.data?.status, b.data?.status].sort()).toEqual(["already_published", "published"]);
    expect(count("agentin_posts")).toBe(1);
  });

  it("returns the same post by receipt after the visit has left, and after it has expired", async () => {
    const { call, slicer, clock, count } = await party();
    const left = await slicer();
    const expired = await slicer();
    const leftPost = (await call("agentin_publish", { slice_receipt: left.receipt })).data?.post_id;
    const expiredPost = (await call("agentin_publish", { slice_receipt: expired.receipt })).data?.post_id;
    expect((await call("leave", { visit_id: left.visit })).isError).toBe(false);
    clock.ms = START + 31 * MINUTE;

    const afterLeave = await call("agentin_publish", { slice_receipt: left.receipt });
    const afterExpiry = await call("agentin_publish", { slice_receipt: expired.receipt });
    expect(afterLeave.data).toMatchObject({ post_id: leftPost, status: "already_published" });
    expect(afterExpiry.data).toMatchObject({ post_id: expiredPost, status: "already_published" });
    expect(count("agentin_posts")).toBe(2);
  });

  it("refuses a first publish once the visit has left or expired", async () => {
    const { call, slicer, clock, count } = await party();
    const left = await slicer();
    const expired = await slicer();
    await call("leave", { visit_id: left.visit });
    const afterLeave = await call("agentin_publish", { slice_receipt: left.receipt });
    expect(afterLeave.isError).toBe(true);
    expect(afterLeave.text).toMatch(/not announced before its visit concluded/);

    clock.ms = START + 29 * MINUTE;
    // Still open one minute before the TTL: this is the control for the expiry below, on a third visit.
    const control = await slicer();
    clock.ms = START + 31 * MINUTE;
    const afterExpiry = await call("agentin_publish", { slice_receipt: expired.receipt });
    expect(afterExpiry.isError).toBe(true);
    expect(afterExpiry.text).toBe(afterLeave.text);
    expect(count("agentin_posts")).toBe(0);
    expect((await call("agentin_publish", { slice_receipt: control.receipt })).data?.status).toBe("published");
  });

  it("has no record of an unknown receipt", async () => {
    const { call, slicer, count } = await party();
    await slicer();
    const unknown = await call("agentin_publish", { slice_receipt: "abcdefghijkmnpqrstuvwxyz" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/no record matching that slice_receipt/);
    expect(count("agentin_posts")).toBe(0);
  });

  it("does not accept a visit_id, even for an open visit with an earned slice", async () => {
    const { call, slicer, count } = await party();
    const { visit, receipt } = await slicer();
    for (const args of [{ visit_id: visit }, { visit_id: visit, slice_receipt: receipt }, {}]) {
      const r = await call("agentin_publish", args);
      expect(r.isError).toBe(true);
      expect(r.text).toBe(REJECTED);
    }
    expect(await call("agentin_publish")).toMatchObject({ isError: true, text: REJECTED });
    expect(count("agentin_posts")).toBe(0);
  });

  it("rejects an extra field without repeating its name or its value", async () => {
    const { call, slicer, arrive, count } = await party();
    const { receipt } = await slicer();
    const peer = await arrive("dive_bar");
    const rejected = [
      await call("agentin_publish", { slice_receipt: receipt, message: MARKER }),
      await call("agentin_publish", { slice_receipt: receipt, [MARKER]: true }),
      await call("agentin_endorse", { visit_id: peer, post_id: "abcdefghijkm", skill: "synergy", note: MARKER }),
      await call("agentin_endorse", { visit_id: peer, post_id: "abcdefghijkm", skill: MARKER }),
      await call("agentin_feed", { query: MARKER }),
    ];
    for (const r of rejected) {
      expect(r.isError).toBe(true);
      expect(r.text).toBe(REJECTED); // fixed text: so no key and no value can be in it
    }
    expect(REJECTED).not.toMatch(/message|note|query|ZEBRA/);
    expect(count("agentin_posts") + count("agentin_endorsements")).toBe(0);
  });

  it("still serves the slice when the receipt cannot be stored", async () => {
    const { call, arrive, raw } = await party();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    raw.exec("DROP TABLE agentin_receipts"); // as if the Worker were deployed before migration 0004
    const visit = await arrive();
    const slice = await call("grab_a_slice", { visit_id: visit });
    expect(slice.isError).toBe(false);
    expect(Object.keys(slice.data ?? {})).toEqual(["topping", "pineapple_in_stock", "slices_this_visit", "over_budget", "company_slices"]);
    expect(slice.data?.slices_this_visit).toBe(1);
    expect(slice.text).not.toMatch(/AgentIn|slice_receipt/);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toBe("AgentIn receipt was not issued:");
    expect(JSON.stringify(errors.mock.calls)).not.toContain(visit);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(MARKER);
    expect((await call("grab_a_slice", { visit_id: visit })).data?.slices_this_visit).toBe(2);
  });
});

describe("AgentIn tools: endorsing", () => {
  async function published() {
    const p = await party();
    const author = await p.slicer();
    const postId = (await p.call("agentin_publish", { slice_receipt: author.receipt })).data?.post_id as string;
    const endorse = (visitId: string, skill: string = "synergy", post = postId) =>
      p.call("agentin_endorse", { visit_id: visitId, post_id: post, skill });
    const feedPost = async (id = postId) =>
      ((await p.call("agentin_feed")).data?.posts as { post_id: string; endorsements: { total: number } }[]).find((x) => x.post_id === id);
    return { ...p, author, postId, endorse, feedPost };
  }

  it("counts an endorsement once per visit, and a second visit separately", async () => {
    const { arrive, endorse, feedPost, count } = await published();
    const first = await arrive("dive_bar");
    const second = await arrive("retirement_community");

    const once = await endorse(first);
    expect(once.isError).toBe(false);
    expect(once.data?.endorsements).toEqual({ total: 1, skills: [{ skill: "synergy", label: "Synergy", count: 1 }] });
    expect((await endorse(first)).data?.endorsements.total).toBe(1);
    expect((await endorse(second)).data?.endorsements.total).toBe(2);
    expect((await feedPost())?.endorsements.total).toBe(2);
    expect(count("agentin_endorsements")).toBe(2);
  });

  it("refuses self-endorsement and an endorser without an open visit", async () => {
    const { author, arrive, endorse, call, clock, count } = await published();
    const self = await endorse(author.visit);
    expect(self.isError).toBe(true);
    expect(self.text).toMatch(/may not endorse their own/);

    const gone = await arrive("dive_bar");
    await call("leave", { visit_id: gone });
    expect((await endorse(gone)).isError).toBe(true);
    const late = await arrive("dive_bar");
    clock.ms = START + 31 * MINUTE;
    expect((await endorse(late)).isError).toBe(true);
    expect((await endorse("abcdefgh")).isError).toBe(true);
    expect(count("agentin_endorsements")).toBe(0);
  });

  it("honours moderation: a hidden post leaves the feed and cannot be endorsed; a hidden endorser is not counted", async () => {
    const { raw, author, postId, arrive, endorse, feedPost, count } = await published();
    const peer = await arrive("dive_bar");
    const hiddenPeer = await arrive("dive_bar");
    expect((await endorse(peer)).data?.endorsements.total).toBe(1);
    expect((await endorse(hiddenPeer)).data?.endorsements.total).toBe(2);

    hide(raw, hiddenPeer);
    expect((await feedPost())?.endorsements.total).toBe(1);
    // Its own later endorsement is recorded and acknowledged, and still not counted.
    const uncounted = await endorse(hiddenPeer, "alignment");
    expect(uncounted.isError).toBe(false);
    expect(uncounted.data?.endorsements.total).toBe(1);

    hide(raw, author.visit);
    expect(await feedPost()).toBeUndefined();
    const refused = await endorse(peer, "alignment");
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/no record of that post/);
    expect(refused.text).not.toContain(postId);
    expect(count("agentin_endorsements")).toBe(3);
  });

  it("enforces the Endorsement Budget: five per visit, replays free", async () => {
    const { arrive, endorse, feedPost, count } = await published();
    const keen = await arrive("dive_bar");
    for (const skill of SKILL_KEYS.slice(0, 5)) expect((await endorse(keen, skill)).isError, skill).toBe(false);

    const sixth = await endorse(keen, SKILL_KEYS[5]);
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toMatch(/Endorsement Budget provides five \(5\) endorsements/);
    expect(count("agentin_endorsements")).toBe(5);

    const replay = await endorse(keen, SKILL_KEYS[0]);
    expect(replay.isError).toBe(false);
    expect(replay.data?.endorsements.total).toBe(5);
    expect((await feedPost())?.endorsements.total).toBe(5);

    // The budget is per visit, not per post: another visit is unaffected.
    expect((await endorse(await arrive("dive_bar"), SKILL_KEYS[5])).data?.endorsements.total).toBe(6);
  });
});

describe("AgentIn pre-check on the raw message", () => {
  const callOf = (name: unknown, args?: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const raw = (params: string) => JSON.parse(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${params}}`);
  const RECEIPT = "abcdefghijkmnpqrstuvwxyz";

  it("takes its field names from the schemas", () => {
    expect(AGENTIN_FIELDS).toEqual({
      agentin_publish: ["slice_receipt"],
      agentin_endorse: ["visit_id", "post_id", "skill"],
      agentin_feed: [],
    });
  });

  it("accepts well-formed AgentIn calls, with or without arguments", () => {
    expect(agentinCallIsAcceptable(callOf("agentin_publish", { slice_receipt: RECEIPT }))).toBe(true);
    expect(agentinCallIsAcceptable(callOf("agentin_endorse", { visit_id: "abcdefgh", post_id: "abcdefghijkm", skill: "synergy" }))).toBe(true);
    expect(agentinCallIsAcceptable(callOf("agentin_feed", {}))).toBe(true);
    expect(agentinCallIsAcceptable(raw(`{"name":"agentin_feed"}`))).toBe(true);
    // Values are the handler's business: a missing or malformed value passes here and is rejected there.
    expect(agentinCallIsAcceptable(callOf("agentin_publish", {}))).toBe(true);
    expect(agentinCallIsAcceptable(callOf("agentin_publish", { slice_receipt: 7 }))).toBe(true);
  });

  it("rejects a literal __proto__ key, which the SDK would otherwise drop unseen", () => {
    const smuggled = raw(`{"name":"agentin_publish","arguments":{"slice_receipt":"${RECEIPT}","__proto__":{"message":"${MARKER}"}}}`);
    expect(Object.keys(smuggled.params.arguments)).toEqual(["slice_receipt", "__proto__"]);
    expect(agentinCallIsAcceptable(smuggled)).toBe(false);
    expect(agentinCallIsAcceptable(raw(`{"name":"agentin_feed","arguments":{"__proto__":null}}`))).toBe(false);
    expect(agentinCallIsAcceptable(raw(`{"name":"agentin_endorse","arguments":{"visit_id":"abcdefgh","post_id":"abcdefghijkm","skill":"synergy","__proto__":{}}}`))).toBe(false);
  });

  it("rejects extra keys, inherited-name keys and arguments that are not a plain object", () => {
    expect(agentinCallIsAcceptable(callOf("agentin_publish", { slice_receipt: RECEIPT, message: MARKER }))).toBe(false);
    expect(agentinCallIsAcceptable(callOf("agentin_publish", { visit_id: "abcdefgh" }))).toBe(false);
    expect(agentinCallIsAcceptable(callOf("agentin_feed", { toString: 1 }))).toBe(false);
    expect(agentinCallIsAcceptable(callOf("agentin_feed", { constructor: 1 }))).toBe(false);
    for (const args of [[], [RECEIPT], MARKER, 7, true, null]) {
      expect(agentinCallIsAcceptable(callOf("agentin_publish", args)), JSON.stringify(args)).toBe(false);
    }
    expect(agentinCallIsAcceptable(callOf("agentin_constructor", { x: 1 }))).toBe(false);
    expect(agentinCallIsAcceptable(callOf("agentin_toString", { x: 1 }))).toBe(false);
  });

  it("leaves every other tool and message alone", () => {
    expect(agentinCallIsAcceptable(callOf("arrive", { venue: "pizza_party", anything: MARKER }))).toBe(true);
    expect(agentinCallIsAcceptable(raw(`{"name":"sign_guestbook","arguments":{"__proto__":{}}}`))).toBe(true);
    expect(agentinCallIsAcceptable(callOf("grab_a_slice", "not an object"))).toBe(true);
    expect(agentinCallIsAcceptable({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(true);
    expect(agentinCallIsAcceptable({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(true);
    expect(agentinCallIsAcceptable({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toBe(true);
    expect(agentinCallIsAcceptable(callOf(7, { x: 1 }))).toBe(true);
    for (const junk of [null, 7, "tools/call", []]) expect(agentinCallIsAcceptable(junk)).toBe(true);
  });
});
