import { VISIT_TTL_MS } from "../db";
import { BLANK_BOOKMARK, HOUSE_MARK, PAGE_SIZE } from "./rules";

// The single source for every surface that shows the book: the MCP tools, the public routes and the export.
// Nothing here returns a visit_id, a pen hash or a timestamp next to a word, and a struck word (its visit
// hidden) leaves here as the house mark. The one exception is wordByVisit, which serves the writer's own retry.

export interface BookReading {
  /** Words in the book at the time of the reading. Struck positions count. */
  total_words: number;
  /** First position of the reading (>= 1). */
  from: number;
  /** Last position returned; from - 1 when the reading is empty. */
  to: number;
  /** Positions from..to in order. A struck position holds the house mark. */
  words: string[];
  /** Positions within from..to that are struck, ascending. */
  struck_positions: number[];
  /** Where to continue; null when this reading reached the end of the book. */
  next_from: number | null;
  /** The book's current bookmark, only when this reading reached the end; otherwise null. */
  bookmark: string | null;
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

/** Positions from..to as displayed. A word whose visit is hidden (or missing) is the house mark. */
async function displayed(db: D1Database, from: number, to: number): Promise<{ words: string[]; struck_positions: number[] }> {
  const words: string[] = [];
  const struck_positions: number[] = [];
  if (to < from) return { words, struck_positions };
  const { results } = await db
    .prepare(
      `SELECT w.position, w.word, COALESCE(v.hidden, 1) AS hidden
         FROM book_words w LEFT JOIN visits v ON v.visit_id = w.visit_id
        WHERE w.position >= ? AND w.position <= ?
        ORDER BY w.position`,
    )
    .bind(from, to)
    .all<{ position: number; word: string; hidden: number }>();
  for (const row of results) {
    const struck = row.hidden !== 0;
    words.push(struck ? HOUSE_MARK : row.word);
    if (struck) struck_positions.push(row.position);
  }
  return { words, struck_positions };
}

/**
 * Read the book from `from` (default 1), at most `limit` words (default and cap PAGE_SIZE).
 * The head is read first and the page is bounded by it, so total_words, bookmark and words agree with each
 * other even if a word lands in between. A `from` beyond the end is read as the position after the last word:
 * an empty reading that has reached the end and carries the bookmark.
 */
export async function readBook(db: D1Database, from: number = 1, limit: number = PAGE_SIZE): Promise<BookReading> {
  const head = await bookHead(db);
  const total = head.total_words;
  const size = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : PAGE_SIZE, 1), PAGE_SIZE);
  const start = Math.min(Math.max(Number.isFinite(from) ? Math.floor(from) : 1, 1), total + 1);
  const to = Math.min(start + size - 1, total);
  const page = await displayed(db, start, to);
  const atEnd = to >= total;
  return {
    total_words: total,
    from: start,
    to,
    words: page.words,
    struck_positions: page.struck_positions,
    next_from: atEnd ? null : to + 1,
    bookmark: atEnd ? head.bookmark : null,
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
