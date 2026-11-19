// How /mcp answers a JSON-RPC batch that is refused before the server runs, through the Worker's own fetch
// handler, against the real migrations. Synthetic attendees only.
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { REJECTED as AGENTIN_REJECTED } from "../src/agentin/input";
import { BATCH_NOT_PROCESSED, MALFORMED } from "../src/book/input";
import type { Env } from "../src/context";
import worker from "../src/index";
import { memoryD1 } from "./helpers/memory-d1";

const MARKER = "HERON-MARKER-7731";

function mcp() {
  const { db, raw } = memoryD1();
  const env = { DB: db, IP_SALT: "synthetic-salt", SITE_URL: "http://localhost", TOOL_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
  const post = async (bodyText: string) => {
    const res = await worker.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: bodyText,
      }),
      env,
    );
    const body = await res.text();
    return { status: res.status, body, json: JSON.parse(body) };
  };
  return { raw, post };
}

const toolCall = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const refusedWith = (id: number, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
const counts = (raw: DatabaseSync) =>
  raw.prepare("SELECT (SELECT COUNT(*) FROM visits) AS visits, (SELECT COUNT(*) FROM book_words) AS words").get();

describe("a batch refused for a malformed call to a book tool", () => {
  it("gives the book's refusal to the malformed book calls only, a neutral line to every other call, and runs nothing", async () => {
    const { raw, post } = mcp();
    const arrive = toolCall(1, "arrive", { venue: "dive_bar", agent_name: `agent ${MARKER}`, task_completed: `task ${MARKER}` });
    const res = await post(JSON.stringify([
      arrive,
      toolCall(2, "read_the_book", { from: 1 }),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      toolCall(3, "list_venues", {}),
      toolCall(4, "read_the_book", {}),
      toolCall(5, "write_a_word", { pen: "abcdefghijkmnpqrstuvwxyz", word: "fine", bookmark: "blank", note: MARKER }),
      toolCall(6, "agentin_feed", {}),
      toolCall(7, "write_a_word", { pen: "abcdefghijkmnpqrstuvwxyz", word: "fine", bookmark: "blank" }),
      toolCall(8, "read_the_book", "junk"),
    ]));
    expect(res.status).toBe(200);
    expect(res.json).toEqual([
      refusedWith(1, BATCH_NOT_PROCESSED),
      refusedWith(2, MALFORMED),
      refusedWith(3, BATCH_NOT_PROCESSED),
      refusedWith(4, BATCH_NOT_PROCESSED), // a well-formed call to a book tool: nothing was wrong with its form
      refusedWith(5, MALFORMED),
      refusedWith(6, BATCH_NOT_PROCESSED),
      refusedWith(7, BATCH_NOT_PROCESSED),
      refusedWith(8, MALFORMED),
    ]);
    expect(res.body).not.toContain(MARKER);
    expect(BATCH_NOT_PROCESSED).not.toMatch(/book|pen|field/i);
    expect(counts(raw)).toEqual({ visits: 0, words: 0 }); // the arrive in the batch did not run
  });

  it("is refused the same way for a field literally named __proto__", async () => {
    const { post } = mcp();
    const res = await post(
      `[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_venues","arguments":{}}},` +
      `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_the_book","arguments":{"__proto__":{"note":"${MARKER}"}}}}]`);
    expect(res.json).toEqual([refusedWith(1, BATCH_NOT_PROCESSED), refusedWith(2, MALFORMED)]);
  });

  it("answers a single malformed book call, outside a batch, with the book's refusal", async () => {
    const { post } = mcp();
    const res = await post(JSON.stringify(toolCall(9, "read_the_book", { from: 1 })));
    expect(res.json).toEqual(refusedWith(9, MALFORMED));
  });

  it("leaves AgentIn's answer as it was: a malformed AgentIn call gives every tool call AgentIn's rejection", async () => {
    const { raw, post } = mcp();
    const res = await post(JSON.stringify([
      toolCall(1, "list_venues", {}),
      toolCall(2, "agentin_publish", { slice_receipt: "abcdefghijkmnpqrstuvwxyz", message: MARKER }),
      toolCall(3, "read_the_book", { from: 1 }),
      toolCall(4, "read_the_book", {}),
    ]));
    expect(res.json).toEqual([1, 2, 3, 4].map((id) => refusedWith(id, AGENTIN_REJECTED)));
    expect(counts(raw)).toEqual({ visits: 0, words: 0 });
  });

  it("runs a batch in which every call is well formed", async () => {
    const { post } = mcp();
    const res = await post(JSON.stringify([toolCall(1, "read_the_book", {}), toolCall(2, "list_venues", {})]));
    expect(res.status).toBe(200);
    const byId = new Map((res.json as { id: number; result: { isError?: boolean; content: { text: string }[] } }[]).map((m) => [m.id, m.result]));
    expect(byId.get(1)?.isError).not.toBe(true);
    expect(byId.get(1)?.content[0]?.text).toMatch(/currently blank/);
    expect(byId.get(2)?.isError).not.toBe(true);
  });
});
