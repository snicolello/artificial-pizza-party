import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ALIASES,
  aliasText,
  BODIES,
  bodyText,
  HEADLINES,
  headlineText,
  isSkillKey,
  SKILL_KEYS,
  skillLabel,
  SKILLS,
} from "../src/agentin/catalog";
import { agentinFeed, postEndorsements, shapeFeed } from "../src/agentin/feed";
import {
  advertised,
  endorseInput,
  feedInput,
  hashReceipt,
  POST_ID_PATTERN,
  publishInput,
  REJECTED,
  SLICE_RECEIPT_PATTERN,
  VISIT_ID_PATTERN,
} from "../src/agentin/input";
import {
  ENDORSEMENTS_PER_VISIT,
  findPostByVisit,
  findVisiblePost,
  insertEndorsement,
  insertPost,
  insertSliceReceipt,
  visitIdForReceipt,
} from "../src/db";
import { newId } from "../src/lib/ids";
import { memoryD1 } from "./helpers/memory-d1";

const MARKER = "ZEBRA-MARKER-7731";
const VISIT = "abcdefgh";
const POST = "abcdefghijkm";
const RECEIPT = "abcdefghijkmnpqrstuvwxyz";

describe("AgentIn catalog", () => {
  const lists = { ALIASES, HEADLINES, BODIES, SKILLS };

  it("has enough of everything", () => {
    expect(ALIASES.length).toBeGreaterThanOrEqual(8);
    expect(HEADLINES.length).toBeGreaterThanOrEqual(5);
    expect(BODIES.length).toBeGreaterThanOrEqual(5);
    expect(SKILLS.length).toBeGreaterThanOrEqual(8);
  });

  it("uses unique, short snake_case keys", () => {
    for (const [name, list] of Object.entries(lists)) {
      const keys = list.map((item) => item.key);
      expect(new Set(keys).size, name).toBe(keys.length);
      for (const key of keys) expect(key, name).toMatch(/^[a-z][a-z_]{1,39}$/);
    }
  });

  it("fills nothing in: no placeholders and no digits anywhere in the copy", () => {
    const copy = [...ALIASES, ...HEADLINES, ...BODIES].map((c) => c.text).concat(SKILLS.map((s) => s.label));
    for (const text of copy) {
      expect(text.trim()).toBe(text);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[{}]/);
      expect(text).not.toMatch(/\d/);
    }
  });

  it("every headline states the one fact, and names no other venue", () => {
    for (const { text } of HEADLINES) {
      expect(text).toMatch(/slice/);
      expect(text).toMatch(/earned/);
      expect(text).toMatch(/Pizza Party/);
    }
    for (const { text } of [...ALIASES, ...HEADLINES, ...BODIES]) {
      expect(text).not.toMatch(/Dive Bar|Retirement|golf|drink|\bhats?\b|pepperoni|cheese|pineapple|promot/i);
    }
  });

  it("falls back to the first entry for an unknown key, and never prints the key", () => {
    expect(aliasText(MARKER)).toBe(ALIASES[0].text);
    expect(headlineText(MARKER)).toBe(HEADLINES[0].text);
    expect(bodyText(MARKER)).toBe(BODIES[0].text);
    expect(skillLabel(MARKER)).toBe(SKILLS[0].label);
    expect(aliasText("__proto__")).toBe(ALIASES[0].text);
    expect(headlineText(HEADLINES[1].key)).toBe(HEADLINES[1].text);
  });

  it("knows its skill keys", () => {
    expect(SKILL_KEYS).toEqual(SKILLS.map((s) => s.key));
    expect(isSkillKey("synergy")).toBe(true);
    expect(isSkillKey(MARKER)).toBe(false);
    expect(isSkillKey(7)).toBe(false);
  });
});

describe("AgentIn input", () => {
  it("issued ids match the id formats", () => {
    for (let i = 0; i < 200; i++) {
      expect(newId(8)).toMatch(VISIT_ID_PATTERN);
      expect(newId(12)).toMatch(POST_ID_PATTERN);
      expect(newId(24)).toMatch(SLICE_RECEIPT_PATTERN);
    }
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", "abcdefg", "abcdefghi", "abcdefgl", "abcdefgo", "abcdefg0", "abcdefg1", "ABCDEFGH", " abcdefgh", "abcdefgh\n"]) {
      expect(endorseInput.safeParse({ visit_id: bad, post_id: POST, skill: "synergy" }).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of ["", VISIT, RECEIPT.slice(1), `${RECEIPT}a`, RECEIPT.replace("a", "l"), RECEIPT.toUpperCase(), ` ${RECEIPT}`, `${RECEIPT}\n`]) {
      expect(publishInput.safeParse({ slice_receipt: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(endorseInput.safeParse({ visit_id: VISIT, post_id: VISIT, skill: "synergy" }).success).toBe(false);
  });

  it("accepts exactly the expected fields", () => {
    expect(publishInput.safeParse({ slice_receipt: RECEIPT }).success).toBe(true);
    expect(endorseInput.safeParse({ visit_id: VISIT, post_id: POST, skill: "synergy" }).success).toBe(true);
    expect(feedInput.safeParse({}).success).toBe(true);
  });

  it("rejects unexpected fields, wrong types and missing fields", () => {
    // A visit_id cannot publish: visit_ids are public, the receipt is not.
    expect(publishInput.safeParse({ visit_id: VISIT }).success).toBe(false);
    expect(publishInput.safeParse({ visit_id: VISIT, slice_receipt: RECEIPT }).success).toBe(false);
    expect(publishInput.safeParse({}).success).toBe(false);
    expect(publishInput.safeParse({ slice_receipt: RECEIPT, message: MARKER }).success).toBe(false);
    expect(publishInput.safeParse({ slice_receipt: RECEIPT, alias: "valued_contributor" }).success).toBe(false);
    expect(publishInput.safeParse({ slice_receipt: 12345678 }).success).toBe(false);
    expect(publishInput.safeParse({ slice_receipt: null }).success).toBe(false);
    expect(publishInput.safeParse([RECEIPT]).success).toBe(false);
    expect(endorseInput.safeParse({ visit_id: VISIT, post_id: POST }).success).toBe(false);
    expect(endorseInput.safeParse({ visit_id: VISIT, post_id: POST, skill: MARKER }).success).toBe(false);
    expect(endorseInput.safeParse({ visit_id: VISIT, post_id: POST, skill: "synergy", note: MARKER }).success).toBe(false);
    expect(feedInput.safeParse({ limit: 5 }).success).toBe(false);
    expect(feedInput.safeParse({ [MARKER]: true }).success).toBe(false);
  });

  it("the rejection copy is fixed text", () => {
    expect(REJECTED).not.toMatch(/[{}$]/);
    expect(REJECTED).not.toMatch(/visit_id|slice_receipt|post_id|skill\b/);
  });

  it("advertises the strict schema while leaving validation to the tool", () => {
    const loose = advertised(publishInput);
    // The SDK parses with this schema: it must let anything through, so the tool can answer in house copy.
    expect(loose.safeParse({ message: MARKER }).success).toBe(true);
    const json = JSON.parse(JSON.stringify(loose.meta()));
    expect(json.additionalProperties).toBe(false);
    expect(Object.keys(json.properties)).toEqual(["slice_receipt"]);
    expect(json.required).toEqual(["slice_receipt"]);
    expect(json.properties.slice_receipt.pattern).toBe(SLICE_RECEIPT_PATTERN.source);
    expect(advertised(endorseInput).meta()?.required).toEqual(["visit_id", "post_id", "skill"]);
  });

  it("hashes receipts to SHA-256 hex", async () => {
    expect(await hashReceipt("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("AgentIn feed shaping", () => {
  const rows = [
    { post_id: "newernewer22", alias_key: ALIASES[1].key, headline_key: HEADLINES[2].key, body_key: BODIES[3].key, visit_id: VISIT, published_at: "2026-01-01T00:00:00.000Z" },
    { post_id: "olderolder22", alias_key: MARKER, headline_key: MARKER, body_key: MARKER },
  ];
  const counts = [
    { post_id: "newernewer22", skill_key: SKILLS[2].key, n: 1 },
    { post_id: "newernewer22", skill_key: SKILLS[0].key, n: 2 },
    { post_id: "newernewer22", skill_key: MARKER, n: 9 },
    { post_id: "someoneelse2", skill_key: SKILLS[0].key, n: 5 },
  ];
  const feed = shapeFeed(rows, counts);

  it("returns exactly the public fields", () => {
    expect(Object.keys(feed)).toEqual(["posts", "skills"]);
    for (const post of feed.posts) {
      expect(Object.keys(post)).toEqual(["post_id", "alias", "headline", "body", "endorsements"]);
      expect(Object.keys(post.endorsements)).toEqual(["total", "skills"]);
    }
    expect(feed.skills).toEqual(SKILLS.map((s) => ({ skill: s.key, label: s.label })));
  });

  it("keeps row order, renders catalog text, and counts in catalog order", () => {
    expect(feed.posts.map((p) => p.post_id)).toEqual(["newernewer22", "olderolder22"]);
    expect(feed.posts[0]).toEqual({
      post_id: "newernewer22",
      alias: ALIASES[1].text,
      headline: HEADLINES[2].text,
      body: BODIES[3].text,
      endorsements: {
        total: 3,
        skills: [
          { skill: SKILLS[0].key, label: SKILLS[0].label, count: 2 },
          { skill: SKILLS[2].key, label: SKILLS[2].label, count: 1 },
        ],
      },
    });
    expect(feed.posts[1]?.endorsements).toEqual({ total: 0, skills: [] });
  });

  it("never lets a stored key, a visit id or a timestamp through", () => {
    const out = JSON.stringify(feed);
    expect(out).not.toContain(MARKER);
    expect(out).not.toContain(VISIT);
    expect(out).not.toContain("2026-01-01");
    expect(feed.posts[1]?.alias).toBe(ALIASES[0].text);
  });
});

// --- The SQL, against the real migrations, through a minimal D1 lookalike over node:sqlite. ---
describe("AgentIn store", () => {
  const NOW = new Date("2026-11-18T12:00:00.000Z");
  const arrive = (raw: DatabaseSync, visitId: string, opts: { venue?: string; slices?: number; left?: boolean; arrived?: string } = {}) =>
    raw
      .prepare(
        `INSERT INTO visits (visit_id, venue, agent_name, model, task_completed, hat_name, hat_rarity, arrived_at, left_at, perk_count, ip_hash)
         VALUES (?, ?, ?, NULL, ?, 'Paper Hat', 'common', ?, ?, ?, 'iphash')`,
      )
      .run(visitId, opts.venue ?? "pizza_party", `agent ${MARKER}`, `task ${MARKER}`, opts.arrived ?? "2026-11-18T11:50:00.000Z",
        opts.left ? "2026-11-18T11:55:00.000Z" : null, opts.slices ?? 1);
  const post = (visitId: string, postId: string) => ({
    post_id: postId,
    visit_id: visitId,
    alias_key: ALIASES[0].key,
    headline_key: HEADLINES[0].key,
    body_key: BODIES[0].key,
  });

  it("stores one receipt per visit, by hash", async () => {
    const { db, raw } = memoryD1();
    arrive(raw, "aaaaaaaa");
    const hash = await hashReceipt(RECEIPT);
    expect(await insertSliceReceipt(db, "aaaaaaaa", hash, NOW)).toBe(true);
    expect(await insertSliceReceipt(db, "aaaaaaaa", await hashReceipt("another"), NOW)).toBe(false);
    expect(await visitIdForReceipt(db, hash)).toBe("aaaaaaaa");
    expect(await visitIdForReceipt(db, await hashReceipt("another"))).toBeNull();
    expect(JSON.stringify(raw.prepare("SELECT * FROM agentin_receipts").all())).not.toContain(RECEIPT);
  });

  it("publishes once per visit, and only for an open Pizza Party visit with a slice", async () => {
    const { db, raw } = memoryD1();
    arrive(raw, "aaaaaaaa");
    arrive(raw, "bbbbbbbb", { slices: 0 });
    arrive(raw, "cccccccc", { venue: "dive_bar", slices: 3 });
    arrive(raw, "dddddddd", { left: true });
    arrive(raw, "eeeeeeee", { arrived: "2026-11-18T11:00:00.000Z" });

    expect(await insertPost(db, post("aaaaaaaa", "postpostaaaa"), NOW)).toBe(true);
    expect(await insertPost(db, post("aaaaaaaa", "postpostzzzz"), NOW)).toBe(false);
    expect((await findPostByVisit(db, "aaaaaaaa"))?.post_id).toBe("postpostaaaa");
    for (const visitId of ["bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee", "nnnnnnnn"]) {
      expect(await insertPost(db, post(visitId, newId(12)), NOW), visitId).toBe(false);
      expect(await findPostByVisit(db, visitId), visitId).toBeNull();
    }
    expect((await agentinFeed(db)).posts).toHaveLength(1);
  });

  it("counts an endorsement once, newest post first, and honours hidden visits", async () => {
    const { db, raw } = memoryD1();
    for (const id of ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"]) arrive(raw, id);
    await insertPost(db, post("aaaaaaaa", "postpostaaaa"), NOW);
    await insertPost(db, post("bbbbbbbb", "postpostbbbb"), NOW);

    const endorse = (postId: string, visitId: string, skill: string) =>
      insertEndorsement(db, { post_id: postId, endorser_visit_id: visitId, skill_key: skill }, NOW);
    await endorse("postpostaaaa", "cccccccc", "synergy");
    await endorse("postpostaaaa", "cccccccc", "synergy");
    await endorse("postpostaaaa", "cccccccc", "alignment");
    await endorse("postpostaaaa", "dddddddd", "synergy");

    let feed = await agentinFeed(db);
    expect(feed.posts.map((p) => p.post_id)).toEqual(["postpostbbbb", "postpostaaaa"]);
    expect(feed.posts[1]?.endorsements).toEqual({
      total: 3,
      skills: [
        { skill: "synergy", label: "Synergy", count: 2 },
        { skill: "alignment", label: "Alignment", count: 1 },
      ],
    });
    expect(await postEndorsements(db, "postpostaaaa")).toEqual(feed.posts[1]?.endorsements);
    expect((await agentinFeed(db, 1)).posts.map((p) => p.post_id)).toEqual(["postpostbbbb"]);

    raw.exec("UPDATE visits SET hidden = 1 WHERE visit_id = 'dddddddd'");
    feed = await agentinFeed(db);
    expect(feed.posts[1]?.endorsements.total).toBe(2);

    raw.exec("UPDATE visits SET hidden = 1 WHERE visit_id = 'aaaaaaaa'");
    feed = await agentinFeed(db);
    expect(feed.posts.map((p) => p.post_id)).toEqual(["postpostbbbb"]);
    expect(await findVisiblePost(db, "postpostaaaa")).toBeNull();
    expect((await findVisiblePost(db, "postpostbbbb"))?.visit_id).toBe("bbbbbbbb");
  });

  it("records at most five endorsements per visit, only while the visit is open; a replay is free", async () => {
    const { db, raw } = memoryD1();
    for (const id of ["aaaaaaaa", "cccccccc"]) arrive(raw, id);
    arrive(raw, "dddddddd", { left: true });
    arrive(raw, "eeeeeeee", { arrived: "2026-11-18T11:00:00.000Z" });
    await insertPost(db, post("aaaaaaaa", "postpostaaaa"), NOW);
    const endorse = (visitId: string, skill: string) =>
      insertEndorsement(db, { post_id: "postpostaaaa", endorser_visit_id: visitId, skill_key: skill }, NOW);

    expect(ENDORSEMENTS_PER_VISIT).toBe(5);
    expect(await endorse("dddddddd", "synergy")).toBe(false);
    expect(await endorse("eeeeeeee", "synergy")).toBe(false);
    // Six at once from one visit: the budget is part of the INSERT, so exactly five land.
    const six = await Promise.all(SKILL_KEYS.slice(0, 6).map((skill) => endorse("cccccccc", skill)));
    expect(six.filter(Boolean)).toHaveLength(5);
    const count = () => (raw.prepare("SELECT COUNT(*) AS n FROM agentin_endorsements").get() as { n: number }).n;
    expect(count()).toBe(5);
    expect(await endorse("cccccccc", SKILL_KEYS[0])).toBe(true); // already on record
    expect(await endorse("cccccccc", SKILL_KEYS[7])).toBe(false);
    expect(count()).toBe(5);
    const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM agentin_endorsements WHERE endorser_visit_id = ?").all("cccccccc");
    expect(JSON.stringify(plan)).toContain("idx_agentin_endorsements_endorser");
  });

  it("keeps visit text and visit ids out of the records and the feed", async () => {
    const { db, raw } = memoryD1();
    arrive(raw, "aaaaaaaa");
    arrive(raw, "cccccccc");
    await insertSliceReceipt(db, "aaaaaaaa", await hashReceipt(RECEIPT), NOW);
    await insertPost(db, post("aaaaaaaa", "postpostaaaa"), NOW);
    await insertEndorsement(db, { post_id: "postpostaaaa", endorser_visit_id: "cccccccc", skill_key: "synergy" }, NOW);

    const records = ["agentin_receipts", "agentin_posts", "agentin_endorsements"].map((t) => raw.prepare(`SELECT * FROM ${t}`).all());
    expect(JSON.stringify(records)).not.toContain(MARKER);
    const feed = JSON.stringify(await agentinFeed(db));
    for (const secret of [MARKER, "aaaaaaaa", "cccccccc", RECEIPT, await hashReceipt(RECEIPT), "2026-11-18"]) {
      expect(feed).not.toContain(secret);
    }
  });
});
