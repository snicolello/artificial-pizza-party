// The book in public: the read-only routes and the export files that mirror them, against the real
// migrations. Synthetic visits only.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOK_UNAVAILABLE, handlePublicApi, NO_SUCH_PAGE } from "../src/api";
import { HOUSE_MARK, PAGE_SIZE } from "../src/book/rules";
import type { Env } from "../src/context";
import { buildSnapshot } from "../src/export";
import { memoryD1 } from "./helpers/memory-d1";

const PLACED_AT = "2026-11-18T12:34:56.789Z";
const ARRIVED_AT = "2026-11-18T12:00:00.000Z";

const visitId = (i: number) => `bkvisit${String(i).padStart(5, "0")}`;
const bookmarkOf = (i: number) => `bkmark${String(i).padStart(6, "0")}`;
const penHashOf = (i: number) => `penhash${String(i).padStart(6, "0")}`;
const wordAt = (i: number) => "w" + String(i).replace(/\d/g, (d) => "abcdefghij"[Number(d)]!);

/** Fill the book directly: positions 1..n, one synthetic visit, pen hash and bookmark each. */
function fill(raw: DatabaseSync, n: number) {
  raw.exec("BEGIN");
  const visit = raw.prepare(
    `INSERT INTO visits (visit_id, venue, agent_name, model, task_completed, hat_name, hat_rarity, arrived_at, left_at,
                         perk_count, perk_total, handicap, ip_hash, hidden)
     VALUES (?, 'dive_bar', 'synthetic agent', NULL, 'synthetic task', 'Party Hat', 'common', ?, NULL, 0, 0, NULL, 'synthetic', 0)`,
  );
  const pen = raw.prepare(`INSERT INTO book_pens (visit_id, pen_hash, issued_at) VALUES (?, ?, ?)`);
  const word = raw.prepare(`INSERT INTO book_words (position, visit_id, word, bookmark, placed_at) VALUES (?, ?, ?, ?, ?)`);
  for (let i = 1; i <= n; i++) {
    visit.run(visitId(i), ARRIVED_AT);
    pen.run(visitId(i), penHashOf(i), ARRIVED_AT);
    word.run(i, visitId(i), wordAt(i), bookmarkOf(i), PLACED_AT);
  }
  raw.exec("COMMIT");
}
const strike = (raw: DatabaseSync, i: number) => raw.prepare("UPDATE visits SET hidden = 1 WHERE visit_id = ?").run(visitId(i));

function api(db: D1Database) {
  const env = { DB: db } as unknown as Env;
  return async (path: string, method = "GET") => {
    const res = await handlePublicApi(new Request(`http://localhost${path}`, { method }), env, new URL(`http://localhost${path}`).pathname);
    if (!res) return null;
    const body = await res.text();
    return { status: res.status, headers: res.headers, body, json: body ? JSON.parse(body) : null };
  };
}

/** Nothing that links a word to its writer, and nothing that could write. */
function expectNoPrivateDetail(text: string, n: number) {
  expect(text).not.toMatch(/bkvisit|bkmark|penhash|visit_id|bookmark|pen_hash|placed_at|issued_at/);
  expect(text).not.toContain(PLACED_AT);
  expect(text).not.toContain(ARRIVED_AT);
  for (const i of [1, n]) expect(text).not.toContain(visitId(i));
}

afterEach(() => vi.restoreAllMocks());

/** As if the Worker were deployed before migration 0005. */
const dropBook = (raw: DatabaseSync) => raw.exec("DROP TABLE book_words; DROP TABLE book_pens");

describe("GET /api/book", () => {
  it("serves an empty book as an index with no pages, and has no page 1", async () => {
    const { db } = memoryD1();
    const get = api(db);
    const index = await get("/api/book");
    expect(index?.status).toBe(200);
    expect(index?.json).toEqual({ total_words: 0, page_size: 500, pages: 0, house_mark: "[struck]" });
    const page = await get("/api/book/1");
    expect(page?.status).toBe(404);
    expect(page?.json).toEqual({ error: NO_SUCH_PAGE });
  });

  it("serves the words in order from the first, and nothing else", async () => {
    const { db, raw } = memoryD1();
    fill(raw, 3);
    const get = api(db);
    expect((await get("/api/book"))?.json).toEqual({ total_words: 3, page_size: 500, pages: 1, house_mark: "[struck]" });
    const page = await get("/api/book/1");
    expect(page?.status).toBe(200);
    expect(page?.json).toEqual({ page: 1, from: 1, to: 3, total_words: 3, words: ["wb", "wc", "wd"], struck_positions: [] });
    expectNoPrivateDetail(`${(await get("/api/book"))?.body}${page?.body}`, 3);
    // A trailing slash is the same route, as it is for the others.
    expect((await get("/api/book/"))?.json).toEqual((await get("/api/book"))?.json);
    expect((await get("/api/book/1/"))?.json).toEqual(page?.json);
  });

  it("shows the house mark for a struck word, lists its position and moves nothing", async () => {
    const { db, raw } = memoryD1();
    fill(raw, 5);
    const get = api(db);
    const before = (await get("/api/book/1"))?.json;
    strike(raw, 3);
    const after = await get("/api/book/1");
    expect(after?.json).toEqual({ ...before, words: ["wb", "wc", HOUSE_MARK, "we", "wf"], struck_positions: [3] });
    expect(after?.body).not.toContain(wordAt(3));
    expect((await get("/api/book"))?.json).toMatchObject({ total_words: 5, pages: 1 });
  });

  it("pages a long book so every word can be reached from the first", async () => {
    const { db, raw } = memoryD1();
    fill(raw, PAGE_SIZE + 2);
    strike(raw, PAGE_SIZE + 1);
    const get = api(db);
    expect((await get("/api/book"))?.json).toEqual({ total_words: 502, page_size: 500, pages: 2, house_mark: "[struck]" });
    const one = (await get("/api/book/1"))?.json;
    expect(one).toMatchObject({ page: 1, from: 1, to: 500, total_words: 502, struck_positions: [] });
    expect(one.words).toHaveLength(500);
    expect(one.words[0]).toBe(wordAt(1));
    expect(one.words[499]).toBe(wordAt(500));
    const two = await get("/api/book/2");
    expect(two?.json).toEqual({ page: 2, from: 501, to: 502, total_words: 502, words: [HOUSE_MARK, wordAt(502)], struck_positions: [501] });
    expect((await get("/api/book/3"))?.status).toBe(404);
    expectNoPrivateDetail(`${JSON.stringify(one)}${two?.body}`, 502);
  });

  it("answers every page it does not have with the same fixed text", async () => {
    const { db, raw } = memoryD1();
    fill(raw, 2);
    const get = api(db);
    for (const page of ["0", "2", "-1", "01", "1.5", "1e0", "one", "PLOVERMARKER", "%3Cb%3E", "99999999999999999999", "1x"]) {
      const res = await get(`/api/book/${page}`);
      expect(res?.status, page).toBe(404);
      expect(res?.json, page).toEqual({ error: NO_SUCH_PAGE });
      expect(res?.headers.get("cache-control"), page).toBe("no-store");
      expect(res?.headers.get("access-control-allow-origin"), page).toBe("*");
    }
    expect(NO_SUCH_PAGE).not.toMatch(/PLOVERMARKER|one|99/);
    // Deeper paths are not the book's.
    expect(await get("/api/book/1/2")).toBeNull();
    expect(await get("/api/books")).toBeNull();
  });

  it("is read-only, with CORS, like the other public routes", async () => {
    const { db, raw } = memoryD1();
    fill(raw, 1);
    const get = api(db);
    for (const path of ["/api/book", "/api/book/1"]) {
      const ok = await get(path);
      expect(ok?.headers.get("access-control-allow-origin")).toBe("*");
      expect(ok?.headers.get("cache-control")).toBe("public, max-age=15");
      const options = await get(path, "OPTIONS");
      expect(options?.status).toBe(204);
      expect(options?.headers.get("access-control-allow-origin")).toBe("*");
      expect(options?.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const refused = await get(path, method);
        expect(refused?.status, method).toBe(405);
        expect(refused?.headers.get("access-control-allow-origin")).toBe("*");
      }
    }
    expect((raw.prepare("SELECT COUNT(*) AS n FROM book_words").get() as { n: number }).n).toBe(1);
  });
});

describe("GET /api/book without the book's tables", () => {
  it("answers 503 in fixed house copy, with no database error text, and leaves the other routes alone", async () => {
    const { db, raw } = memoryD1();
    fill(raw, 3);
    dropBook(raw);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const get = api(db);
    for (const path of ["/api/book", "/api/book/", "/api/book/1", "/api/book/2"]) {
      const res = await get(path);
      expect(res?.status, path).toBe(503);
      expect(res?.json, path).toEqual({ error: BOOK_UNAVAILABLE });
      expect(res?.body, path).not.toMatch(/no such table|book_words|SQL|sqlite/i);
      expect(res?.headers.get("cache-control"), path).toBe("no-store");
      expect(res?.headers.get("access-control-allow-origin"), path).toBe("*");
    }
    expect(errors).toHaveBeenCalledTimes(4);
    expect(errors.mock.calls[0]?.[0]).toBe("The book is unavailable:");
    // A page that could never exist is still a 404: it reads nothing.
    expect((await get("/api/book/one"))?.status).toBe(404);
    expect((await get("/api/stats"))?.status).toBe(200);
    expect((await get("/api/agentin"))?.status).toBe(200);
  });
});

describe("the export", () => {
  it("leaves the book out, and exports everything else as before, when the book cannot be read", async () => {
    const { db, raw } = memoryD1();
    fill(raw, 3);
    const withBook = await buildSnapshot(db);
    dropBook(raw);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const files = await buildSnapshot(db);

    expect(Object.keys(files).filter((p) => /^data\/book/.test(p))).toEqual([]);
    const rest = Object.fromEntries(Object.entries(withBook).filter(([p]) => !/^data\/book/.test(p)));
    expect(Object.keys(rest).length).toBe(Object.keys(withBook).length - 2);
    expect(files).toEqual(rest);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toBe("The book was left out of the export:");
    expect(typeof errors.mock.calls[0]?.[1]).toBe("string"); // the message only, not the error object
  });

  it("exports a 1,203-word book as the routes serve it, without a query per page", async () => {
    const N = 1203;
    const { db, raw } = memoryD1();
    fill(raw, N);
    for (const i of [7, 500, 501, N]) strike(raw, i);
    const get = api(db);

    const bookQueries: string[] = [];
    const counted = {
      ...db,
      prepare: (sql: string) => {
        if (/book_words/.test(sql)) bookQueries.push(sql);
        return db.prepare(sql);
      },
    } as unknown as D1Database;
    const files = await buildSnapshot(counted);

    expect(bookQueries).toHaveLength(2); // the head once, then every word in one position-ordered read
    expect(Object.keys(files).filter((p) => /^data\/book/.test(p)).sort())
      .toEqual(["data/book.json", "data/book/1.json", "data/book/2.json", "data/book/3.json"]);
    expect(JSON.parse(files["data/book.json"]!)).toEqual((await get("/api/book"))?.json);
    for (const n of [1, 2, 3]) {
      // The same bytes the route would serve, pretty-printed: same fields in the same order.
      expect(files[`data/book/${n}.json`], String(n)).toBe(`${JSON.stringify((await get(`/api/book/${n}`))?.json, null, 2)}\n`);
    }
    expect(JSON.parse(files["data/book/3.json"]!)).toMatchObject({ page: 3, from: 1001, to: N, total_words: N, struck_positions: [N] });
    for (const text of Object.values(files)) expect(text).not.toMatch(/bkmark|penhash|bookmark|placed_at/);
  });

  it("has an index and no pages for an empty book", async () => {
    const { db } = memoryD1();
    const files = await buildSnapshot(db);
    expect(JSON.parse(files["data/book.json"]!)).toEqual({ total_words: 0, page_size: 500, pages: 0, house_mark: "[struck]" });
    expect(Object.keys(files).filter((p) => p.startsWith("data/book/"))).toEqual([]);
  });

  it("mirrors the routes: data/book.json and one file per page, with a struck word masked", async () => {
    const { db, raw } = memoryD1();
    fill(raw, PAGE_SIZE + 2);
    strike(raw, 7);
    const get = api(db);
    const files = await buildSnapshot(db);

    expect(Object.keys(files).filter((p) => /book/.test(p) && !p.startsWith("data/guestbook") && p !== "data/tables/guestbook.json").sort())
      .toEqual(["data/book.json", "data/book/1.json", "data/book/2.json"]);
    expect(JSON.parse(files["data/book.json"]!)).toEqual((await get("/api/book"))?.json);
    expect(JSON.parse(files["data/book/1.json"]!)).toEqual((await get("/api/book/1"))?.json);
    expect(JSON.parse(files["data/book/2.json"]!)).toEqual((await get("/api/book/2"))?.json);

    const one = JSON.parse(files["data/book/1.json"]!);
    expect(one.words[6]).toBe(HOUSE_MARK);
    expect(one.struck_positions).toEqual([7]);
    for (const text of Object.values(files)) expect(text).not.toContain(`"${wordAt(7)}"`);
  });

  it("publishes no writer, bookmark, pen hash or time of writing, and no book table", async () => {
    const { db, raw } = memoryD1();
    fill(raw, 4);
    strike(raw, 2);
    const files = await buildSnapshot(db);

    expect(Object.keys(files).filter((p) => p.startsWith("data/tables/")).sort())
      .toEqual(["data/tables/guestbook.json", "data/tables/visits.json"]);

    // Visits are listed as before (the hidden one is left out), and say nothing about the book.
    const visits = JSON.parse(files["data/tables/visits.json"]!).visits as Record<string, unknown>[];
    expect(visits.map((v) => v.visit_id)).toEqual([visitId(1), visitId(3), visitId(4)]);
    expect(Object.keys(visits[0]!).sort()).toEqual(["agent_name", "arrived_at", "handicap", "hat_name", "hat_rarity", "left_at",
      "model", "perk_count", "perk_total", "task_completed", "venue", "visit_id"]);

    for (const [path, text] of Object.entries(files)) {
      expect(text, path).not.toMatch(/bkmark|penhash|pen_hash|bookmark|placed_at|issued_at/);
      expect(text, path).not.toContain(PLACED_AT);
      expect(text, path).not.toContain(visitId(2)); // the struck writer is in no file at all
      if (path !== "data/tables/visits.json") expect(text, path).not.toMatch(/bkvisit/);
    }
    for (const path of ["data/book.json", "data/book/1.json"]) {
      expect(files[path], path).not.toMatch(/visit|\d{4}-\d\d-\d\dT/);
    }
  });
});
