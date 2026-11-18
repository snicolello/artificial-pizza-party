// A small in-memory stand-in for D1, backed by node:sqlite, with the real migrations applied.
// It covers the calls the Worker makes: prepare().bind().first()/all()/run() and batch().
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.params as never[])) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const { changes } = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { meta: { changes: Number(changes) } };
  }
}

export interface TestDb {
  /** Pass as env.DB. */
  d1: D1Database;
  /** Direct access, for moderation and for inspecting rows. */
  raw: DatabaseSync;
}

export function createTestDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS).sort()) raw.exec(readFileSync(MIGRATIONS + file, "utf8"));
  const d1 = {
    prepare: (sql: string) => new Statement(raw, sql),
    batch: (statements: Statement[]) => Promise.all(statements.map((s) => s.all())),
  };
  return { d1: d1 as unknown as D1Database, raw };
}
