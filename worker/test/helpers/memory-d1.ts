import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** The real migrations, in order, behind a minimal D1 lookalike over node:sqlite. For tests only. */
export function memoryD1(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) raw.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string, params: (string | number | null)[] = []) => ({
    bind: (...next: (string | number | null)[]) => statement(sql, next),
    first: async () => raw.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...params).changes) } }),
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { all: () => Promise<unknown> }[]) => Promise.all(statements.map((s) => s.all())),
  };
  return { db: db as unknown as D1Database, raw };
}
