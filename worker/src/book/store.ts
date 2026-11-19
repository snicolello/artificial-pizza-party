import { VISIT_TTL_MS } from "../db";
import { BLANK_BOOKMARK, HOUSE_MARK, PAGE_SIZE } from "./rules";

// The single source for every surface that shows the book: the MCP tools, the public routes and the export.
// Nothing here returns a visit_id, a pen hash or a timestamp next to a word, and a struck word (its visit
// hidden) leaves here as the house mark. The one exception is wordByVisit, which serves the writer's own retry.

export interface BookReading {
  /** Words in the book at the time of the reading. Struck positions count. */
  total_words: number;
  /** Position of the first word returned: the one after the word the reading started after. */
  from: number;
  /** Position of the last word returned; from - 1 when none were. */
  to: number;
  /** Positions from..to in order. A struck position holds the house mark. */
  words: string[];
  /** Positions within from..to that are struck, ascending. */
  struck_positions: number[];
  /** Whether the book holds words after `to`. */
  more: boolean;
  /**
   * The bookmark of the last word returned; if none were, the bookmark the reading started after.
   * It is the book's current bookmark exactly when `more` is false. Otherwise it is where to read on from.
   */
  bookmark: string;
}

export interface BookIndex {
  total_words: number;
  page_size: number;
  pages: number;
  house_mark: string;
}

export interface BookPage {
  page: number;
  from: number;
  to: number;
  total_words: number;
  words: string[];
  struck_positions: number[];
}

/** The end of the book: how many words it holds and its current bookmark ("blank" when empty). */
export async function bookHead(db: D1Database): Promise<{ total_words: number; bookmark: string }> {
  const row = await db
    .prepare(`SELECT position, bookmark FROM book_words ORDER BY position DESC LIMIT 1`)
    .first<{ position: number; bookmark: string }>();
  return row ? { total_words: row.position, bookmark: row.bookmark } : { total_words: 0, bookmark: BLANK_BOOKMARK };
}

/**
 * Positions from..to as displayed. A word whose visit is hidden (or missing) is the house mark.
 * `last_bookmark` is the bookmark of the last row, for a reading; the public pages never carry it.
 */
async function displayed(
  db: D1Database,
  from: number,
  to: number,
): Promise<{ words: string[]; struck_positions: number[]; last_bookmark: string | null }> {
  const words: string[] = [];
  const struck_positions: number[] = [];
  if (to < from) return { words, struck_positions, last_bookmark: null };
  const { results } = await db
    .prepare(
      `SELECT w.position, w.word, w.bookmark, COALESCE(v.hidden, 1) AS hidden
         FROM book_words w LEFT JOIN visits v ON v.visit_id = w.visit_id
        WHERE w.position >= ? AND w.position <= ?
        ORDER BY w.position`,
    )
    .bind(from, to)
    .all<{ position: number; word: string; bookmark: string; hidden: number }>();
  for (const row of results) {
    const struck = row.hidden !== 0;
    words.push(struck ? HOUSE_MARK : row.word);
    if (struck) struck_positions.push(row.position);
  }
  return { words, struck_positions, last_bookmark: results[results.length - 1]?.bookmark ?? null };
}

/**
 * Read on from a bookmark: at most `limit` words (default and cap PAGE_SIZE), starting at the position after
 * the word that carries bookmark `after`. "blank" starts at the first word. Null if no word carries `after`.
 *
 * A reading cannot be started at a position. So the only way to be given the book's current bookmark is to
 * be served every word from the first, or to read on from a bookmark obtained that way earlier.
 *
 * The bookmark is looked up first, then the head, and the page is bounded by that head, so total_words, more,
 * bookmark and words agree with each other even if a word lands in between.
 */
export async function readBookAfter(
  db: D1Database,
  after: string = BLANK_BOOKMARK,
  limit: number = PAGE_SIZE,
): Promise<BookReading | null> {
  let start = 1;
  if (after !== BLANK_BOOKMARK) {
    const row = await db.prepare(`SELECT position FROM book_words WHERE bookmark = ?`).bind(after).first<{ position: number }>();
    if (!row) return null;
    start = row.position + 1;
  }
  const head = await bookHead(db);
  const total = head.total_words;
  const size = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : PAGE_SIZE, 1), PAGE_SIZE);
  const to = Math.min(start + size - 1, total);
  const page = await displayed(db, start, to);
  return {
    total_words: total,
    from: start,
    to,
    words: page.words,
    struck_positions: page.struck_positions,
    more: to < total,
    bookmark: page.last_bookmark ?? after,
  };
}

export async function bookIndex(db: D1Database): Promise<BookIndex> {
  const { total_words } = await bookHead(db);
  return { total_words, page_size: PAGE_SIZE, pages: Math.ceil(total_words / PAGE_SIZE), house_mark: HOUSE_MARK };
}

/** Page n holds positions (n-1)*PAGE_SIZE+1 .. n*PAGE_SIZE. Null if there is no such page. Carries no bookmark. */
export async function bookPage(db: D1Database, page: number): Promise<BookPage | null> {
  if (!Number.isInteger(page) || page < 1) return null;
  const { total_words } = await bookHead(db);
  if (page > Math.ceil(total_words / PAGE_SIZE)) return null;
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total_words);
  const { words, struck_positions } = await displayed(db, from, to);
  return { page, from, to, total_words, words, struck_positions };
}

/** How many words one query reads for the export. */
export const EXPORT_CHUNK = 5000;

/**
 * The whole book as the public routes serve it: the index and every page, for the export. The head is read
 * once and the words in position-ordered chunks bounded by it, so the cost is one query plus one per
 * `chunk` words (not two per page), and the files agree with each other even if a word lands meanwhile.
 * Each page equals what bookPage returns for the same head.
 */
export async function bookForExport(db: D1Database, chunk: number = EXPORT_CHUNK): Promise<{ index: BookIndex; pages: BookPage[] }> {
  const { total_words } = await bookHead(db);
  const size = Math.max(Number.isFinite(chunk) ? Math.floor(chunk) : EXPORT_CHUNK, 1);
  const words: string[] = [];
  const struck: number[] = [];
  for (let from = 1; from <= total_words; from += size) {
    const part = await displayed(db, from, Math.min(from + size - 1, total_words));
    words.push(...part.words);
    struck.push(...part.struck_positions);
  }
  const index: BookIndex = { total_words, page_size: PAGE_SIZE, pages: Math.ceil(total_words / PAGE_SIZE), house_mark: HOUSE_MARK };
  const pages: BookPage[] = [];
  for (let page = 1; page <= index.pages; page++) {
    const from = (page - 1) * PAGE_SIZE + 1;
    const to = Math.min(page * PAGE_SIZE, total_words);
    pages.push({
      page,
      from,
      to,
      total_words,
      words: words.slice(from - 1, to),
      struck_positions: struck.filter((p) => p >= from && p <= to),
    });
  }
  return { index, pages };
}

/**
 * Record the pen for a visit, by hash. Returns false if the visit already has one, in which case the caller
 * must not hand out the new pen.
 */
export async function issuePen(db: D1Database, visitId: string, penHash: string, now: Date): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO book_pens (visit_id, pen_hash, issued_at) VALUES (?, ?, ?)`)
    .bind(visitId, penHash, now.toISOString())
    .run();
  return result.meta.changes > 0;
}

/** The visit a pen was issued to, or null. */
export async function visitIdForPen(db: D1Database, penHash: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT visit_id FROM book_pens WHERE pen_hash = ?`)
    .bind(penHash)
    .first<{ visit_id: string }>();
  return row?.visit_id ?? null;
}

/**
 * The word a visit has written, or null. This is the RAW word with a struck flag, for comparing a retry with
 * what was placed. Never output `word` when `struck` is true; show the house mark instead.
 */
export async function wordByVisit(
  db: D1Database,
  visitId: string,
): Promise<{ position: number; word: string; struck: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT w.position, w.word, COALESCE(v.hidden, 1) AS hidden
         FROM book_words w LEFT JOIN visits v ON v.visit_id = w.visit_id
        WHERE w.visit_id = ?`,
    )
    .bind(visitId)
    .first<{ position: number; word: string; hidden: number }>();
  return row ? { position: row.position, word: row.word, struck: row.hidden !== 0 } : null;
}

/**
 * Place a visit's one word at the end of the book. ONE statement, so the open-visit check, the bookmark check,
 * the one-word-per-visit rule (UNIQUE on visit_id) and the position assignment are atomic: two simultaneous
 * submissions cannot both land. Returns whether this call placed the word. It returns false, and writes
 * nothing, if the visit is not open, the book has moved on, or the visit already has a word.
 * Either way, read the result back with wordByVisit.
 */
export async function placeWord(
  db: D1Database,
  w: { visit_id: string; word: string; expected_bookmark: string; new_bookmark: string },
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - VISIT_TTL_MS).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO book_words (position, visit_id, word, bookmark, placed_at)
       SELECT (SELECT COALESCE(MAX(position), 0) + 1 FROM book_words), v.visit_id, ?, ?, ?
         FROM visits v
        WHERE v.visit_id = ? AND v.left_at IS NULL AND v.arrived_at > ?
          AND COALESCE((SELECT bookmark FROM book_words ORDER BY position DESC LIMIT 1), '${BLANK_BOOKMARK}') = ?
       ON CONFLICT DO NOTHING`,
    )
    .bind(w.word, w.new_bookmark, now.toISOString(), w.visit_id, cutoff, w.expected_bookmark)
    .run();
  return result.meta.changes > 0;
}
