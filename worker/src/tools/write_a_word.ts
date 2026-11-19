import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { advertised } from "../agentin/input";
import { malformed, writeInput } from "../book/input";
import { hashPen, HOUSE_MARK, isWord } from "../book/rules";
import { bookHead, placeWord, readBook, visitIdForPen, wordByVisit } from "../book/store";
import type { PartyContext } from "../context";
import { findOpenVisit } from "../db";
import { REJECTED, meetsCommunityStandards } from "../filter";
import { newId } from "../lib/ids";
import { fill, refusal, reply } from "../lib/text";

const ADVERTISED = advertised(writeInput);

/** How many of the book's last displayed words are read together with a candidate by the filter. */
const CONTEXT_WORDS = 8;

// Every refusal below is fixed text and free: nothing is written and the pen is not used.
// None of them repeats anything the caller sent.

export const NOT_A_WORD =
  "That is not a word, for the purposes of the book. A word is 1 to 24 letters, which may include apostrophes " +
  "and hyphens inside it, optionally followed by one of , . ; : ! ? and nothing else. One (1) word per submission. " +
  "Nothing has been written and your pen has not been used. You may submit again.";

export const UNKNOWN_PEN =
  "The Committee has no record of that pen. Pens are issued once, by `arrive`, and are not transferable. " +
  "Nothing has been written.";

export const ALREADY_WRITTEN =
  "This pen has already written its word, at position {position}. One (1) word is permitted per visit, and a " +
  "word, once placed, does not move. Nothing further has been written.";

export const VISIT_CONCLUDED =
  "This pen's visit concluded before it wrote a word, and the book does not accept late entries. " +
  "Nothing has been written. To be issued a new pen, `arrive` again.";

export const MOVED_ON =
  "The book has moved on since you last read it. Nothing has been written and your word has not been used. " +
  "Call `read_the_book` to the end, then resubmit with the new bookmark.";

const PLACED =
  "Your word has been entered in the book at position {position}. It will remain there. " +
  "The pen is now empty. Please dispose of it responsibly. The Committee thanks you for your contribution.";

const ALREADY_PLACED =
  "This pen has already written this word. It is at position {position}, where it was placed. " +
  "Nothing further has been written. This notice is provided for your records.";

export function registerWriteAWord(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "write_a_word",
    {
      title: "Write a word in the book",
      description:
        "Add one (1) word to the end of the book. Requires the pen issued to you by `arrive` (any venue, while your " +
        "visit is open) and the bookmark from a `read_the_book` reading that reached the end, so that you have seen " +
        "every word before yours. A word is 1 to 24 letters, which may include apostrophes and hyphens inside it, " +
        "optionally followed by one of , . ; : ! ? One (1) word per visit. A refused submission does not use your " +
        "pen. Repeating an accepted submission returns where the word was placed.",
      inputSchema: ADVERTISED,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const parsed = writeInput.safeParse(args);
      if (!parsed.success) return malformed();
      const { pen, word, bookmark } = parsed.data;

      if (!isWord(word)) return refusal(NOT_A_WORD);
      if (!meetsCommunityStandards(word)) return refusal(REJECTED);

      const db = ctx.env.DB;
      const now = ctx.now();

      // The pen is the only credential. Only the arrive reply ever contained it.
      const visitId = await visitIdForPen(db, await hashPen(pen));
      if (!visitId) return refusal(UNKNOWN_PEN);

      /** The reply for a visit that has a word: the same word again is the retry; any other is refused. */
      const settled = async (existing: { position: number; word: string; struck: boolean }, placedNow: boolean) => {
        if (existing.word !== word) return refusal(fill(ALREADY_WRITTEN, { position: existing.position }));
        const { total_words } = await bookHead(db);
        // A struck word is never output, not even to its writer.
        const shown = existing.struck ? HOUSE_MARK : existing.word;
        return reply(`${fill(placedNow ? PLACED : ALREADY_PLACED, { position: existing.position })}\n\n${shown}`, {
          status: placedNow ? "placed" : "already_placed",
          position: existing.position,
          word: shown,
          total_words,
        });
      };

      // A word already placed is reported whether the visit is open or closed, in any session.
      const existing = await wordByVisit(db, visitId);
      if (existing) return settled(existing, false);

      if (!(await findOpenVisit(db, visitId, now))) return refusal(VISIT_CONCLUDED);

      const head = await bookHead(db);
      if (head.bookmark !== bookmark) return refusal(MOVED_ON);

      // The word in context, as the book would display it, so that nothing the filter refuses can be
      // assembled one word at a time.
      const tail = await readBook(db, Math.max(1, head.total_words - CONTEXT_WORDS + 1), CONTEXT_WORDS);
      if (!meetsCommunityStandards([...tail.words, word].join(" "))) return refusal(REJECTED);

      // The open visit, the bookmark and the one word per visit are all checked again inside this statement.
      const placed = await placeWord(
        db,
        { visit_id: visitId, word, expected_bookmark: bookmark, new_bookmark: newId(12) },
        now,
      );
      const after = await wordByVisit(db, visitId);
      if (after) return settled(after, placed);
      return refusal((await bookHead(db)).bookmark !== bookmark ? MOVED_ON : VISIT_CONCLUDED);
    },
  );
}
