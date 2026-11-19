import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { advertised } from "../agentin/input";
import { rejected, writeInput } from "../book/input";
import { wordsBefore } from "../book/pages";
import { CONTEXT_WORDS, isWord, wordMeetsCommunityStandards } from "../book/word";
import type { PartyContext } from "../context";
import { findOpenVisit, findWordByVisit, insertWord, visitIdForPen } from "../db";
import { REJECTED as BELOW_STANDARDS } from "../filter";
import { sha256Hex } from "../lib/ids";
import { refusal, reply } from "../lib/text";

const ADVERTISED = advertised(writeInput);

const UNUSED = "Nothing has been written, and your word has not been used.";

const NOT_A_WORD =
  "That is not a word. A word is 1 to 24 letters (A to Z, either case), which may include apostrophes and hyphens " +
  "inside it, optionally followed by one of , . ; : ! ? Nothing else is a word: no spaces, no digits, no links. " +
  UNUSED;

const FILTERED = `${BELOW_STANDARDS} ${UNUSED}`;

const NO_PEN_RECORD =
  "The Committee has no record of that pen. Pens are issued once, by `arrive`, and are not transferable. " +
  "Nothing has been written. To be issued a pen, `arrive` at any venue.";

const VISIT_CONCLUDED =
  "The visit this pen was issued with has concluded, and it did not write. The pen has been retired. " +
  "Nothing has been written. To be issued a new pen, `arrive` at any venue.";

const MOVED_ON =
  "The book has moved on since you last read it: that position is not where the next word goes. " +
  `${UNUSED} Please read the book again with \`read_the_book\`, then resubmit with the position it gives.`;

const WRITTEN =
  "Your word has been entered in the book at position {position}. It will not move. " +
  "Each visit may add exactly one (1) word, and this was yours. The pen now only reports where your word stands.";

const ALREADY_WRITTEN =
  "Our records indicate this pen has already written this word. It stands at position {position}. " +
  "It has been counted once. Nothing further has been written.";

const ONE_WORD_EACH =
  "This pen has already written its one (1) word, which stands at position {position}. Each visit may add exactly one word. " +
  "Nothing further has been written. To write another, return for a new visit.";

export function registerAddAWord(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "add_a_word",
    {
      title: "Add a word to the Book",
      description:
        "Add your one (1) word to the Book, after the last word. Requires an open visit at any venue: takes the pen " +
        "that `arrive` issued with your visit, your word, and the position it would take, which `read_the_book` gives " +
        "where the book ends. If the book has moved on since you read it, nothing is written and your word is not used: " +
        "read again and resubmit. A refused submission never uses up your word. Repeating a submission that already " +
        "succeeded reports where your word stands, even after your visit has closed. Words are public and permanent.",
      inputSchema: ADVERTISED,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const parsed = writeInput.safeParse(args);
      if (!parsed.success) return rejected();
      const { pen, word, position } = parsed.data;
      if (!isWord(word)) return refusal(NOT_A_WORD);
      if (!wordMeetsCommunityStandards(word)) return refusal(FILTERED);

      const db = ctx.env.DB;
      const now = ctx.now();

      // The pen is the only credential. Only the `arrive` reply ever contained it.
      const visitId = await visitIdForPen(db, await sha256Hex(pen));
      if (!visitId) return refusal(NO_PEN_RECORD);

      // A visit that has written gets its placement back, open or closed. That is how a caller whose
      // connection dropped learns where the word landed. A different word is a second word: refused.
      const standing = (placed: { position: number; word: string }, created: boolean) =>
        placed.word === word
          ? reply((created ? WRITTEN : ALREADY_WRITTEN).replace("{position}", String(placed.position)), {
              status: created ? "written" : "already_written",
              position: placed.position,
              word: placed.word,
            })
          : refusal(ONE_WORD_EACH.replace("{position}", String(placed.position)));

      const existing = await findWordByVisit(db, visitId);
      if (existing) return standing(existing, false);

      // The word is read with the words it would follow, but only if it really would follow them.
      // If the book is somewhere else, nothing is inserted and the refusal below says so.
      const before = await wordsBefore(db, position, CONTEXT_WORDS);
      if (before.isNext) {
        if (!wordMeetsCommunityStandards(word, before.words)) return refusal(FILTERED);
        // insertWord checks the open visit, the position and one-word-per-visit again, in the insert itself.
        if (await insertWord(db, { visit_id: visitId, word, position }, now)) return standing({ position, word }, true);
        // Not placed. If this same submission arrived twice at once, the other copy placed it.
        const raced = await findWordByVisit(db, visitId);
        if (raced) return standing(raced, false);
      }

      if (!(await findOpenVisit(db, visitId, now))) return refusal(VISIT_CONCLUDED);
      return refusal(MOVED_ON);
    },
  );
}
