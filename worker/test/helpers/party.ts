// A whole party in memory: the real MCP server over an in-memory transport, on the test database.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Env } from "../../src/context";
import { seededRand } from "../../src/lib/rand";
import { buildServer } from "../../src/server";
import { createTestDb, type TestDb } from "./d1";

export interface ToolReply {
  isError: boolean;
  text: string;
  data: any;
}

export interface Party extends TestDb {
  env: Env;
  /** Move the party's clock forward. */
  advance: (ms: number) => void;
  /** Call a tool from a fresh MCP session, as a caller with this IP hash. */
  call: (name: string, args?: Record<string, unknown>, ipHash?: string) => Promise<ToolReply>;
  /** A fresh MCP session, for listing tools and reading resources. */
  session: (ipHash?: string) => Promise<Client>;
  /** arrive, and return the visit_id. */
  arrive: (venue: string, extra?: Record<string, unknown>) => Promise<string>;
  /** arrive at the Pizza Party and grab one slice. */
  earnSlice: (extra?: Record<string, unknown>) => Promise<{ visitId: string; receipt: string }>;
}

export function createParty(): Party {
  const db = createTestDb();
  let now = Date.parse("2026-11-18T12:00:00.000Z");
  let seed = 1;
  const env = { DB: db.d1, SITE_URL: "http://localhost", IP_SALT: "test" } as Env;

  const session = async (ipHash = "ip-test") => {
    const server = buildServer({ env, ipHash, now: () => new Date(now), rand: seededRand(seed++) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "unit-test", version: "0" });
    await client.connect(clientSide);
    return client;
  };

  const call: Party["call"] = async (name, args = {}, ipHash) => {
    const client = await session(ipHash);
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    await client.close();
    const text = result.content.map((c) => c.text ?? "").join("\n");
    return { isError: result.isError === true, text, data: JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null") };
  };

  const arrive: Party["arrive"] = async (venue, extra = {}) =>
    (await call("arrive", { venue, agent_name: "synthetic-attendee", task_completed: "Attended a unit test", ...extra })).data.visit_id;

  const earnSlice: Party["earnSlice"] = async (extra) => {
    const visitId = await arrive("pizza_party", extra);
    const slice = await call("grab_a_slice", { visit_id: visitId });
    return { visitId, receipt: slice.data.agentin.receipt };
  };

  return { ...db, env, advance: (ms) => void (now += ms), call, session, arrive, earnSlice };
}
