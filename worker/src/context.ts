import type { Rand } from "./lib/text";

export interface Env {
  DB: D1Database;
  /** 60 tool calls per IP per minute. */
  TOOL_LIMITER: RateLimit;
  /** Public page base URL, used for guestbook permalinks. */
  SITE_URL: string;
  /** Secret salt for hashing caller IPs. */
  IP_SALT: string;
  /** Secret for GET /api/feedback (sent as the x-committee-key header). */
  FEEDBACK_KEY?: string;
  /** "true" only in local dev (.dev.vars). Enables the x-party-seed header. */
  TEST_MODE?: string;
  /** Nightly export target, e.g. "snicolello/artificial-pizza-party". */
  GITHUB_REPO: string;
  GITHUB_BRANCH?: string;
  /** Author email on export commits. */
  EXPORT_AUTHOR_EMAIL: string;
  /** Secret: fine-grained token with Contents read/write on GITHUB_REPO only. */
  GITHUB_TOKEN?: string;
}

/** Built fresh for each MCP request (the server is stateless; visit state lives in D1). */
export interface PartyContext {
  env: Env;
  ipHash: string;
  now: () => Date;
  rand: Rand;
}
