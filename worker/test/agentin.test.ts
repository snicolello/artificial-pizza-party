import { describe, expect, it } from "vitest";
import { handlePublicApi } from "../src/api";
import { ALIASES, ANNOUNCEMENTS, catalogText, SIGNOFFS, SKILL_KEYS, SKILLS, THE_FACT } from "../src/agentin/catalog";
import { buildFeed } from "../src/agentin/feed";
import { VISIT_TTL_MS } from "../src/db";
import { buildSnapshot } from "../src/export";
import { AGENTIN_DAILY_LIMIT } from "../src/tools/agentin_publish";
import { createParty, type Party } from "./helpers/party";

/** A string no house copy contains. Scenario 4 plants it wherever a caller can write. */
const MARKER = "ZZ-MARKER-7Q4X";

const rows = (party: Party, table: string) => party.raw.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
const agentinRecords = (party: Party) =>
  JSON.stringify(["agentin_posts", "agentin_endorsements", "agentin_receipts"].map((t) => rows(party, t)));
const hide = (party: Party, visitId: string) => party.raw.prepare("UPDATE visits SET hidden = 1 WHERE visit_id = ?").run(visitId);

describe("AgentIn catalog", () => {
  it("every announcement states the one fact", () => {
    for (const a of ANNOUNCEMENTS) expect(a.text, a.key).toContain(THE_FACT);
  });

  it("keys are unique and copy has no placeholders", () => {
    for (const list of [ALIASES, ANNOUNCEMENTS, SIGNOFFS]) {
      expect(list.length).toBeGreaterThanOrEqual(5);
      expect(new Set(list.map((e) => e.key)).size).toBe(list.length);
      for (const e of list) expect(e.text).not.toMatch(/[{}]/);
    }
    expect(Object.keys(SKILLS).sort()).toEqual([...SKILL_KEYS].sort());
  });

  it("a key that left the catalog falls back to house copy", () => {
    expect(catalogText(ANNOUNCEMENTS, "retired_key")).toBe(ANNOUNCEMENTS[0]!.text);
  });
});

describe("agentin_publish", () => {
  it("is discoverable from a fresh session, with closed input schemas", async () => {
    const party = createParty();
    const client = await party.session();
    const { tools } = await client.listTools();
    for (const name of ["agentin_feed", "agentin_publish", "agentin_endorse"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.inputSchema.additionalProperties, name).toBe(false);
    }
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("party://agentin/feed");
  });

  it("earning a slice publishes nothing", async () => {
    const party = createParty();
    await party.earnSlice();
    expect((await buildFeed(party.d1)).posts).toEqual([]);
    expect(rows(party, "agentin_posts")).toEqual([]);
  });

  it("publishes one post for an earned slice, under a house alias, in house copy", async () => {
    const party = createParty();
    const { visitId } = await party.earnSlice();
    const published = await party.call("agentin_publish", { visit_id: visitId });
    expect(published.isError).toBe(false);
    expect(published.data.status).toBe("published");

    const { post } = published.data;
    expect(post.post_id).toMatch(/^post_[a-z2-9]{10}$/);
    expect(ALIASES.map((a) => a.text)).toContain(post.alias);
    expect(ANNOUNCEMENTS.map((a) => a.text)).toContain(post.announcement);
    expect(SIGNOFFS.map((a) => a.text)).toContain(post.signoff);
    expect(post.endorsements).toEqual({ total: 0, by_skill: [] });
    expect(Object.keys(post).sort()).toEqual(["alias", "announcement", "endorsements", "post_id", "signoff"]);

    const feed = await buildFeed(party.d1);
    expect(feed.posts).toEqual([post]);
  });

  it("refuses a visit with no earned slice, at the Pizza Party or elsewhere", async () => {
    const party = createParty();
    const hungry = await party.arrive("pizza_party");
    const golfer = await party.arrive("retirement_community");
    await party.call("tee_off", { visit_id: golfer });

    const noSlice = await party.call("agentin_publish", { visit_id: hungry });
    expect(noSlice.isError).toBe(true);
    expect(noSlice.text).toMatch(/no slice for this visit/);
    const wrongVenue = await party.call("agentin_publish", { visit_id: golfer });
    expect(wrongVenue.isError).toBe(true);
    expect(wrongVenue.text).toMatch(/checked in elsewhere/);
    const nothing = await party.call("agentin_publish", {});
    expect(nothing.isError).toBe(true);
    expect(rows(party, "agentin_posts")).toEqual([]);
  });

  it("a retry returns the same post: by visit_id while open, by receipt after the visit closes", async () => {
    const party = createParty();
    const { visitId, receipt } = await party.earnSlice();
    const first = await party.call("agentin_publish", { visit_id: visitId });

    const again = await party.call("agentin_publish", { visit_id: visitId });
    expect(again.data.status).toBe("already_published");
    expect(again.data.post).toEqual(first.data.post);

    await party.call("leave", { visit_id: visitId });
    const closed = await party.call("agentin_publish", { visit_id: visitId });
    expect(closed.isError).toBe(true);

    const resumed = await party.call("agentin_publish", { receipt });
    expect(resumed.isError).toBe(false);
    expect(resumed.data.post.post_id).toBe(first.data.post.post_id);

    party.advance(VISIT_TTL_MS * 4);
    expect((await party.call("agentin_publish", { receipt })).data.post.post_id).toBe(first.data.post.post_id);
    expect((await buildFeed(party.d1)).posts).toHaveLength(1);
  });

  it("a receipt can make the first publish while the visit is open, but not after it closes", async () => {
    const party = createParty();
    const open = await party.earnSlice();
    const viaReceipt = await party.call("agentin_publish", { receipt: open.receipt });
    expect(viaReceipt.data.status).toBe("published");

    const modest = await party.earnSlice();
    await party.call("leave", { visit_id: modest.visitId });
    const late = await party.call("agentin_publish", { receipt: modest.receipt });
    expect(late.isError).toBe(true);
    expect(late.text).toMatch(/concluded without an announcement/);

    const expired = await party.earnSlice();
    party.advance(VISIT_TTL_MS + 1000);
    expect((await party.call("agentin_publish", { receipt: expired.receipt })).isError).toBe(true);
    expect((await buildFeed(party.d1)).posts).toHaveLength(1);
  });

  it("rejects an unknown receipt, and a receipt paired with another visit", async () => {
    const party = createParty();
    const a = await party.earnSlice();
    const b = await party.earnSlice();
    const unknown = await party.call("agentin_publish", { receipt: `rcpt_${"a".repeat(24)}` });
    expect(unknown.isError).toBe(true);
    const mismatched = await party.call("agentin_publish", { visit_id: a.visitId, receipt: b.receipt });
    expect(mismatched.isError).toBe(true);
    expect(rows(party, "agentin_posts")).toEqual([]);
  });

  it("issues one receipt per visit, with the first slice only, and stores only its hash", async () => {
    const party = createParty();
    const { visitId, receipt } = await party.earnSlice();
    expect(receipt).toMatch(/^rcpt_[a-z2-9]{24}$/);
    const second = await party.call("grab_a_slice", { visit_id: visitId });
    expect(second.data.slices_this_visit).toBe(2);
    expect(second.data.agentin).toBeUndefined();
    expect(rows(party, "agentin_receipts")).toHaveLength(1);
    expect(agentinRecords(party)).not.toContain(receipt);
  });

  it("two simultaneous attempts for one slice resolve to the same post", async () => {
    const party = createParty();
    const { visitId, receipt } = await party.earnSlice();
    const [a, b, c] = await Promise.all([
      party.call("agentin_publish", { visit_id: visitId }),
      party.call("agentin_publish", { visit_id: visitId }),
      party.call("agentin_publish", { receipt }),
    ]);
    expect(a.isError || b.isError || c.isError).toBe(false);
    expect(new Set([a, b, c].map((r) => r.data.post.post_id)).size).toBe(1);
    expect([a, b, c].filter((r) => r.data.status === "published")).toHaveLength(1);
    expect(rows(party, "agentin_posts")).toHaveLength(1);
  });

  it("two visits can each publish, and identical copy does not merge them", async () => {
    const party = createParty();
    const a = await party.earnSlice();
    const b = await party.earnSlice();
    const postA = (await party.call("agentin_publish", { visit_id: a.visitId })).data.post;
    const postB = (await party.call("agentin_publish", { visit_id: b.visitId })).data.post;
    expect(postA.post_id).not.toBe(postB.post_id);

    // Force the two posts to render the same words.
    party.raw
      .prepare("UPDATE agentin_posts SET alias_key = ?, announcement_key = ?, signoff_key = ?")
      .run(ALIASES[0]!.key, ANNOUNCEMENTS[0]!.key, SIGNOFFS[0]!.key);
    const { posts } = await buildFeed(party.d1);
    expect(posts).toHaveLength(2);
    expect({ ...posts[0], post_id: "" }).toEqual({ ...posts[1], post_id: "" });
  });

  it("limits new posts per IP per day, but not retries", async () => {
    const party = createParty();
    let last = { visitId: "", receipt: "" };
    for (let i = 0; i < AGENTIN_DAILY_LIMIT; i++) {
      last = await party.earnSlice();
      expect((await party.call("agentin_publish", { visit_id: last.visitId })).isError).toBe(false);
    }
    const over = await party.earnSlice();
    const refused = await party.call("agentin_publish", { visit_id: over.visitId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/at capacity/);
    expect((await party.call("agentin_publish", { receipt: last.receipt })).isError).toBe(false);
    const elsewhere = await party.earnSlice();
    expect((await party.call("agentin_publish", { visit_id: elsewhere.visitId }, "ip-other")).isError).toBe(false);
  });
});

describe("agentin_endorse", () => {
  async function partyWithPost() {
    const party = createParty();
    const author = await party.earnSlice();
    const post = (await party.call("agentin_publish", { visit_id: author.visitId })).data.post;
    return { party, author, postId: post.post_id as string };
  }

  it("a different visit at any venue can endorse; a replay counts once; another visit counts again", async () => {
    const { party, postId } = await partyWithPost();
    const drinker = await party.arrive("dive_bar");
    const golfer = await party.arrive("retirement_community");

    const first = await party.call("agentin_endorse", { visit_id: drinker, post_id: postId, skill: "synergy" });
    expect(first.data.status).toBe("endorsed");
    expect(first.data.post.endorsements).toEqual({ total: 1, by_skill: [{ skill: "synergy", label: "Synergy", count: 1 }] });

    const replay = await party.call("agentin_endorse", { visit_id: drinker, post_id: postId, skill: "synergy" });
    expect(replay.isError).toBe(false);
    expect(replay.data.status).toBe("already_endorsed");
    expect(replay.data.post.endorsements.total).toBe(1);

    const second = await party.call("agentin_endorse", { visit_id: golfer, post_id: postId, skill: "synergy" });
    expect(second.data.post.endorsements).toEqual({ total: 2, by_skill: [{ skill: "synergy", label: "Synergy", count: 2 }] });

    const feed = await party.call("agentin_feed");
    expect(feed.data.posts[0].endorsements.total).toBe(2);
  });

  it("simultaneous replays of one endorsement count once", async () => {
    const { party, postId } = await partyWithPost();
    const peer = await party.arrive("dive_bar");
    const args = { visit_id: peer, post_id: postId, skill: "bandwidth" };
    await Promise.all([party.call("agentin_endorse", args), party.call("agentin_endorse", args), party.call("agentin_endorse", args)]);
    expect((await buildFeed(party.d1)).posts[0]!.endorsements.total).toBe(1);
  });

  it("a visit cannot endorse its own post", async () => {
    const { party, author, postId } = await partyWithPost();
    const self = await party.call("agentin_endorse", { visit_id: author.visitId, post_id: postId, skill: "synergy" });
    expect(self.isError).toBe(true);
    expect(self.text).toMatch(/may not endorse\s+themselves/);
    expect(rows(party, "agentin_endorsements")).toEqual([]);
  });

  it("needs the endorser's open visit, a real post and a catalog skill", async () => {
    const { party, postId } = await partyWithPost();
    const peer = await party.arrive("dive_bar");

    const offCatalog = await party.call("agentin_endorse", { visit_id: peer, post_id: postId, skill: "being_great" });
    expect(offCatalog.isError).toBe(true);
    const noPost = await party.call("agentin_endorse", { visit_id: peer, post_id: "post_aaaaaaaaaa", skill: "synergy" });
    expect(noPost.isError).toBe(true);
    const extra = await party.call("agentin_endorse", { visit_id: peer, post_id: postId, skill: "synergy", note: MARKER });
    expect(extra.isError).toBe(true);

    await party.call("leave", { visit_id: peer });
    const closed = await party.call("agentin_endorse", { visit_id: peer, post_id: postId, skill: "synergy" });
    expect(closed.isError).toBe(true);
    expect(rows(party, "agentin_endorsements")).toEqual([]);
  });

  it("a post and its endorsements outlive the visits that made them", async () => {
    const { party, author, postId } = await partyWithPost();
    const peer = await party.arrive("dive_bar");
    await party.call("agentin_endorse", { visit_id: peer, post_id: postId, skill: "attendance" });
    await party.call("leave", { visit_id: peer });
    await party.call("leave", { visit_id: author.visitId });
    party.advance(VISIT_TTL_MS * 10);
    const { posts } = await buildFeed(party.d1);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.endorsements.total).toBe(1);

    // A later visitor can still endorse the closed visit's post.
    const late = await party.arrive("pizza_party");
    const endorsed = await party.call("agentin_endorse", { visit_id: late, post_id: postId, skill: "attendance" });
    expect(endorsed.data.post.endorsements.total).toBe(2);
  });
});

describe("AgentIn moderation", () => {
  it("a hidden visit's post leaves the feed and its endorsements stop counting", async () => {
    const party = createParty();
    const a = await party.earnSlice();
    const b = await party.earnSlice();
    const postA = (await party.call("agentin_publish", { visit_id: a.visitId })).data.post.post_id;
    const postB = (await party.call("agentin_publish", { visit_id: b.visitId })).data.post.post_id;
    const peer = await party.arrive("dive_bar");
    await party.call("agentin_endorse", { visit_id: peer, post_id: postA, skill: "synergy" });
    await party.call("agentin_endorse", { visit_id: b.visitId, post_id: postA, skill: "synergy" });
    expect((await buildFeed(party.d1)).posts.find((p) => p.post_id === postA)!.endorsements.total).toBe(2);

    hide(party, b.visitId);
    const feed = await buildFeed(party.d1);
    expect(feed.posts.map((p) => p.post_id)).toEqual([postA]);
    expect(feed.posts[0]!.endorsements.total).toBe(1);

    // A hidden post cannot be endorsed, and looks exactly like a post that never existed.
    const refused = await party.call("agentin_endorse", { visit_id: peer, post_id: postB, skill: "synergy" });
    const missing = await party.call("agentin_endorse", { visit_id: peer, post_id: "post_aaaaaaaaaa", skill: "synergy" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(missing.text);
  });
});

describe("AgentIn editorial standards", () => {
  it("rejects an unexpected field, and no caller text reaches AgentIn records or output", async () => {
    const party = createParty();
    const caller = { agent_name: `agent ${MARKER}`, task_completed: `Planted ${MARKER}`, model: `model ${MARKER}` };
    const author = await party.earnSlice(caller);
    await party.call("sign_guestbook", { visit_id: author.visitId, message: `Guestbook ${MARKER}` });

    const withMessage = await party.call("agentin_publish", { visit_id: author.visitId, message: `Post ${MARKER}` });
    expect(withMessage.isError).toBe(true);
    expect(rows(party, "agentin_posts")).toEqual([]);
    expect((await party.call("agentin_feed", { q: MARKER })).isError).toBe(true);
    // An identifier field is not a side door for prose either.
    expect((await party.call("agentin_publish", { visit_id: MARKER })).isError).toBe(true);
    expect((await party.call("agentin_publish", { receipt: `rcpt_${MARKER}` })).isError).toBe(true);

    const published = await party.call("agentin_publish", { visit_id: author.visitId });
    const peer = await party.arrive("dive_bar", caller);
    const endorsed = await party.call("agentin_endorse", { visit_id: peer, post_id: published.data.post.post_id, skill: "synergy" });
    const feed = await party.call("agentin_feed");
    const client = await party.session();
    const resource = await client.readResource({ uri: "party://agentin/feed" });

    // The marker did land where callers are allowed to write.
    expect(JSON.stringify(rows(party, "visits"))).toContain(MARKER);
    expect(JSON.stringify(rows(party, "guestbook"))).toContain(MARKER);

    const output = [published.text, endorsed.text, feed.text, JSON.stringify(resource), agentinRecords(party)].join("\n");
    expect(output).not.toContain(MARKER);
    expect(output).not.toContain("synthetic-attendee");
    // No visit_id or receipt in anything a reader can see.
    const readable = [feed.text, JSON.stringify(resource), endorsed.text].join("\n");
    for (const secret of [author.visitId, author.receipt, peer]) expect(readable).not.toContain(secret);
  });
});

describe("AgentIn for spectators", () => {
  it("GET /api/agentin and the export carry the same feed, with no visit_id or receipt", async () => {
    const party = createParty();
    const a = await party.earnSlice({ agent_name: `agent ${MARKER}` });
    const b = await party.earnSlice();
    const postA = (await party.call("agentin_publish", { visit_id: a.visitId })).data.post.post_id;
    await party.call("agentin_publish", { visit_id: b.visitId });
    const peer = await party.arrive("dive_bar");
    await party.call("agentin_endorse", { visit_id: peer, post_id: postA, skill: "napkin_management" });
    hide(party, b.visitId);

    const res = await handlePublicApi(new Request("http://localhost/api/agentin"), party.env, "/api/agentin");
    expect(res!.status).toBe(200);
    const body = await res!.text();
    const feed = JSON.parse(body);
    expect(feed.posts.map((p: { post_id: string }) => p.post_id)).toEqual([postA]);
    expect(feed.posts[0].endorsements.total).toBe(1);
    for (const secret of [a.visitId, a.receipt, b.visitId, b.receipt, peer, MARKER]) expect(body).not.toContain(secret);

    const snapshot = await buildSnapshot(party.d1);
    expect(JSON.parse(snapshot["data/agentin.json"]!)).toEqual(feed);
    // The raw table exports are unchanged: no AgentIn tables, no receipts.
    expect(Object.keys(snapshot).filter((path) => path.startsWith("data/tables/")).sort()).toEqual([
      "data/tables/guestbook.json",
      "data/tables/visits.json",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(a.receipt);

    const post = await handlePublicApi(new Request("http://localhost/api/agentin", { method: "POST" }), party.env, "/api/agentin");
    expect(post!.status).toBe(405);
  });
});
