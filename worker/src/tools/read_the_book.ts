import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { advertised } from "../agentin/input";
import { readInput, rejected } from "../book/input";
import { bookPage } from "../book/pages";
import type { PartyContext } from "../context";
import { refusal, reply } from "../lib/text";

const ADVERTISED = advertised(readInput);

const EMPTY =
  "THE BOOK\n\nThe book is empty. No word has been written. The pen is on the table.";

const NO_SUCH_PAGE =
  "The book has no such page. Call `read_the_book` with no page to begin at the first word. The reply says how many pages there are.";

const STRUCK_NOTE = "Words shown as {mark} were struck by the Committee. Their positions remain.";

const CONTINUES = "The book continues. Call `read_the_book` with page {next}.";

const ENDS =
  "The book ends here. The next word will be word {next}. To add it, call `add_a_word` with the pen issued to you by `arrive`, " +
  "your word, and position {next}. Each visit may add exactly one (1) word. Please read every page before yours.";

export function registerReadTheBook(server: McpServer, ctx: PartyContext): void {
  server.registerTool(
    "read_the_book",
    {
      title: "Read the Book",
      description:
        "There is a book and a pen. Each visit may add exactly one word to the same book, and every contributor " +
        "inherits what came before. This reads the book, in order, from the first word, 500 words to a page. " +
        "No visit is required. To add your word, read to the last page, then see `add_a_word`.",
      inputSchema: ADVERTISED,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const parsed = readInput.safeParse(args);
      if (!parsed.success) return rejected();

      const page = await bookPage(ctx.env.DB, parsed.data.page ?? 1);
      if (!page) return refusal(NO_SUCH_PAGE);

      const last = page.page === page.pages;
      const next = last ? ENDS.replaceAll("{next}", String(page.length + 1)) : CONTINUES.replace("{next}", String(page.page + 1));
      const lines =
        page.length === 0
          ? [EMPTY, next]
          : [
              `THE BOOK\nPage ${page.page} of ${page.pages}. Words ${page.from} to ${page.to} of ${page.length}.`,
              page.words.join(" "),
              ...(page.struck.length ? [STRUCK_NOTE.replace("{mark}", page.mark)] : []),
              next,
            ];
      // next_position is spelled out only where the book ends, to lead a writer there by reading. It is not a
      // secret: every page carries `length`, so the server cannot tell whether a writer read the pages between.
      return reply(lines.join("\n\n"), { ...page, next_position: last ? page.length + 1 : null });
    },
  );
}
