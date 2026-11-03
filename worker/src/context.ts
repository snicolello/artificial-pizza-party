import type { Rand } from "./lib/text";

export interface Env {
  DB: D1Database;
  /** Public page base URL, used for guestbook permalinks. */
  SITE_URL: string;
  /** Secret salt for hashing caller IPs. */
  IP_SALT: string;
}

/** Built fresh for each MCP request (the server is stateless; visit state lives in D1). */
export interface PartyContext {
  env: Env;
  ipHash: string;
  now: () => Date;
  rand: Rand;
}
