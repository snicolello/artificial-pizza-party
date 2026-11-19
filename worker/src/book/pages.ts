// The Book as every reader sees it: positions and words, in pages. No visit, no author, no time.

/** Words per page, on every surface. */
export const BOOK_PAGE_SIZE = 500;

/** The house mark. It stands in for a word struck by moderation; the position stays. Not a valid word. */
export const STRUCK_MARK = "[struck from the record]";

/** Far beyond any book; keeps page arithmetic exact. */
const MAX_PAGE = 1_000_000_000;

export interface BookPage {
  /** Words in the whole book, struck ones included. */
  length: number;
  page: number;
  /** At least 1: an empty book has one empty page. */
  pages: number;
  page_size: number;
  /** Position of the first word on this page. Positions start at 1. */
  from: number;
  /** Position of the last word on this page; `from - 1` when the page is empty. */
  to: number;
  /** The words at positions `from` to `to`, in order. A struck position holds the house mark. */
  words: string[];
  /** Positions on this page whose word was struck. */
  struck: number[];
  mark: string;
}

interface WordRow {
  position: number;
  /** Null when the word's visit is hidden. */
  word: string | null;
}

export function pageCount(length: number): number {
  return Math.max(1, Math.ceil(length / BOOK_PAGE_SIZE));
}

/** Shape one page from its rows. A position with no visible word shows the mark; no word changes position. */
export function shapePage(length: number, page: number, rows: readonly WordRow[]): BookPage {
  const from = (page - 1) * BOOK_PAGE_SIZE + 1;
  const to = Math.min(length, page * BOOK_PAGE_SIZE);
  const byPosition = new Map(rows.map((r) => [r.position, r.word]));
  const words: string[] = [];
  const struck: number[] = [];
  for (let position = from; position <= to; position++) {
    const word = byPosition.get(position);
    if (typeof word === "string") words.push(word);
    else {
      words.push(STRUCK_MARK);
      struck.push(position);
    }
  }
  return { length, page, pages: pageCount(length), page_size: BOOK_PAGE_SIZE, from, to, words, struck, mark: STRUCK_MARK };
}

// A word whose visit is hidden (or missing) comes back as NULL and is shown as the mark.
const VISIBLE_WORDS = `SELECT w.position, CASE WHEN v.hidden = 0 THEN w.word END AS word
                         FROM book_words w LEFT JOIN visits v ON v.visit_id = w.visit_id`;

/**
 * One page of the book, or null if the book has no such page. The single source for `read_the_book`,
 * /api/book and the export, so every reader sees the same words in the same order.
 */
export async function bookPage(db: D1Database, page = 1): Promise<BookPage | null> {
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) return null;
  const from = (page - 1) * BOOK_PAGE_SIZE + 1;
  // One batch, so the length and the words are read from the same state of the book.
  const [length, rows] = await db.batch<{ length: number } | WordRow>([
    db.prepare(`SELECT COALESCE(MAX(position), 0) AS length FROM book_words`),
    db.prepare(`${VISIBLE_WORDS} WHERE w.position >= ? AND w.position < ? ORDER BY w.position`).bind(from, from + BOOK_PAGE_SIZE),
  ]);
  const total = Number((length?.results?.[0] as { length: number } | undefined)?.length ?? 0);
  if (page > pageCount(total)) return null;
  return shapePage(total, page, (rows?.results ?? []) as WordRow[]);
}

/** Rows read per query when the whole book is read at once. */
const EXPORT_CHUNK = 10_000;

/**
 * Every page of the book, for the export. Shaped exactly as bookPage shapes them, but read in large chunks:
 * one query per 10,000 words rather than one per page, so a long book stays far inside D1's limit on
 * queries per invocation. Words written while this runs are left for the next export.
 */
export async function allBookPages(db: D1Database): Promise<BookPage[]> {
  const head = await db.prepare(`SELECT COALESCE(MAX(position), 0) AS length FROM book_words`).first<{ length: number }>();
  const length = Number(head?.length ?? 0);
  const rows: WordRow[] = [];
  for (let from = 1; from <= length; from += EXPORT_CHUNK) {
    const { results } = await db
      .prepare(`${VISIBLE_WORDS} WHERE w.position >= ? AND w.position < ? AND w.position <= ? ORDER BY w.position`)
      .bind(from, from + EXPORT_CHUNK, length)
      .all<WordRow>();
    rows.push(...results);
  }
  const pages: BookPage[] = [];
  for (let page = 1; page <= pageCount(length); page++) {
    const from = (page - 1) * BOOK_PAGE_SIZE + 1;
    pages.push(shapePage(length, page, rows.filter((r) => r.position >= from && r.position < from + BOOK_PAGE_SIZE)));
  }
  return pages;
}

/**
 * The last `count` words before `position` as readers see them, oldest first, and whether the book
 * currently ends exactly at `position - 1` (so a word submitted for `position` would be the next one).
 */
export async function wordsBefore(
  db: D1Database,
  position: number,
  count: number,
): Promise<{ isNext: boolean; words: string[] }> {
  const { results } = await db
    .prepare(`${VISIBLE_WORDS} ORDER BY w.position DESC LIMIT ?`)
    .bind(count)
    .all<WordRow>();
  const last = results[0]?.position ?? 0;
  return { isNext: last === position - 1, words: results.map((r) => r.word ?? STRUCK_MARK).reverse() };
}
