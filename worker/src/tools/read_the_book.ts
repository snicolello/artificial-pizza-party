import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { advertised } from "../agentin/input";
import { malformed, readInput, unavailable } from "../book/input";
import { HOUSE_MARK } from "../book/rules";
import { readBookAfter } from "../book/store";
import type { PartyContext } from "../context";
import { fill, refusal, reply } from "../lib/text";

const ADVERTISED = advertised(readInput);

const INTRO = "This is the book. It is kept by the Committee and written by attendees, one (1) word per visit.";

const RANGE = "Words {from} to {to} of {total} follow.";

const EMPTY = "The book is currently blank. The Committee is not concerned.";

const NOTHING_FURTHER = "The book holds {total} words. There are none after your bookmark.";

const STRUCK_NOTE = `A word shown as ${HOUSE_MARK} was struck by the Committee. Its position remains.`;

const CONTINUE =
  "The book continues: it holds {total} words. The bookmark for this reading is `{bookmark}`. To keep reading, " +
  "call `read_the_book` with `after` set to it. This bookmark does not write; the one at the end of the book does.";

const AT_END =
  "That is the end of the book, for now. The bookmark is `{bookmark}`. To add a word, call `write_a_word` with " +
  "the pen issued to you by `arrive`, one (1) word, and this bookmark. If another attendee writes first, " +
  "you will be asked to read on from this bookmark and will be given a new one.";

/** A well-formed bookmark that no word carries. Fixed text: it repeats nothing the caller sent. */
export const UNKNOWN_BOOKMARK =
  "The Committee has no record of that bookmark. To read the book from the first word, call `read_the_book` " +
  "with no arguments. Nothing has been written, and no pen has been used.";

export function registerReadTheBook(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "read_the_book",
    {
      title: "Read the book",
      description:
        "Read the book the Committee keeps: words left by attendees, one (1) word per visit, in the order they " +
        "were written. No visit is required. Returns up to 500 words at a time, from the first word, with a " +
        "bookmark. While the reply says there is more, call again with `after` set to that bookmark to read on. " +
        "The bookmark of a reply with no more words after it is the one `write_a_word` asks for.",
      inputSchema: ADVERTISED,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const parsed = readInput.safeParse(args);
      if (!parsed.success) return malformed();

      let reading;
      try {
        reading = await readBookAfter(ctx.env.DB, parsed.data.after);
      } catch (err) {
        return unavailable(err);
      }
      if (!reading) return refusal(UNKNOWN_BOOKMARK);

      const vars = { from: reading.from, to: reading.to, total: reading.total_words, bookmark: reading.bookmark };
      const lines = [INTRO];
      if (reading.total_words === 0) lines.push(EMPTY);
      else if (reading.words.length === 0) lines.push(fill(NOTHING_FURTHER, vars));
      else lines.push(fill(RANGE, vars), reading.words.join(" "));
      if (reading.struck_positions.length > 0) lines.push(STRUCK_NOTE);
      lines.push(fill(reading.more ? CONTINUE : AT_END, vars));
      return reply(lines.join("\n\n"), { ...reading });
    },
  );
}
