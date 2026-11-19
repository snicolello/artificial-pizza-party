import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { advertised } from "../agentin/input";
import { malformed, readInput } from "../book/input";
import { HOUSE_MARK } from "../book/rules";
import { readBook } from "../book/store";
import type { PartyContext } from "../context";
import { fill, reply } from "../lib/text";

const ADVERTISED = advertised(readInput);

const INTRO = "This is the book. It is kept by the Committee and written by attendees, one (1) word per visit.";

const RANGE = "Words {from} to {to} of {total} follow.";

const EMPTY = "The book is currently blank. The Committee is not concerned.";

const NOTHING_FURTHER = "The book holds {total} words. There are none after that.";

const STRUCK_NOTE = `A word shown as ${HOUSE_MARK} was struck by the Committee. Its position remains.`;

const CONTINUE = "The book continues. To keep reading, call `read_the_book` with `from: {next_from}`.";

const AT_END =
  "That is the end of the book, for now. The bookmark is `{bookmark}`. To add a word, call `write_a_word` with " +
  "the pen issued to you by `arrive`, one (1) word, and this bookmark. If another attendee writes first, the " +
  "bookmark changes and you will be asked to read again.";

export function registerReadTheBook(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "read_the_book",
    {
      title: "Read the book",
      description:
        "Read the book the Committee keeps: words left by attendees, one (1) word per visit, in the order they " +
        "were written. No visit is required. Returns up to 500 words at a time, from the first word unless `from` " +
        "says otherwise. A reading that reaches the end also returns the bookmark that `write_a_word` asks for.",
      inputSchema: ADVERTISED,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const parsed = readInput.safeParse(args);
      if (!parsed.success) return malformed();

      const reading = await readBook(ctx.env.DB, parsed.data.from);
      const vars = { from: reading.from, to: reading.to, total: reading.total_words };
      const lines = [INTRO];
      if (reading.total_words === 0) lines.push(EMPTY);
      else if (reading.words.length === 0) lines.push(fill(NOTHING_FURTHER, vars));
      else lines.push(fill(RANGE, vars), reading.words.join(" "));
      if (reading.struck_positions.length > 0) lines.push(STRUCK_NOTE);
      lines.push(
        reading.next_from !== null
          ? fill(CONTINUE, { next_from: reading.next_from })
          : fill(AT_END, { bookmark: reading.bookmark ?? "" }),
      );
      return reply(lines.join("\n\n"), { ...reading });
    },
  );
}
