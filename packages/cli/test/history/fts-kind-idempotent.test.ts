// [fix] replaying history_fts kind/body_idx migrations must not abort on a
// desynced journal (column present / absent while name is missing / present).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { ensureHistorySearchColumns } from "../../src/history/ensure-columns"

const migrationSql = (name: string) =>
  readFileSync(join(import.meta.dir, "../../migration", name, "migration.sql"), "utf8")

function splitStmts(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean)
}

function columnNames(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

/** Minimal history_fts + journal so we can replay the two search migrations. */
function baseDb() {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE history_fts (
      part_id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      message_id text NOT NULL,
      project_id text NOT NULL,
      tool_name text,
      body text NOT NULL,
      time_created integer NOT NULL
    );
    CREATE TABLE history_index_migration (
      version integer PRIMARY KEY,
      phase text NOT NULL,
      cursor integer NOT NULL,
      fts_end integer NOT NULL,
      part_end integer NOT NULL
    );
    CREATE TABLE part (id text PRIMARY KEY);
    CREATE TABLE __drizzle_migrations (
      id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT
    );
  `)
  return db
}

function runSql(db: Database, sql: string) {
  for (const stmt of splitStmts(sql)) db.exec(stmt)
}

describe("history FTS kind migrations are idempotent", () => {
  test("stuck client: kind exists, 20261011 not journaled → replay succeeds", () => {
    const db = baseDb()
    db.exec(`ALTER TABLE history_fts ADD COLUMN kind text NOT NULL DEFAULT ''`)
    db.exec(`
      INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
      VALUES ('', 0, '20260914030000_history_remove_kind', '2026-10-13T00:00:00.000Z');
    `)

    // Old SQL used bare ADD COLUMN kind — this is the production failure.
    expect(() => db.exec(`ALTER TABLE history_fts ADD COLUMN kind text NOT NULL DEFAULT ''`))
      .toThrow(/duplicate column name/i)

    // Fixed path: ensure + journal-safe seed.
    const wrapped = {
      client: { prepare: (sql: string) => ({ all: () => db.prepare(sql).all() as never }) },
      run: (q: string) => {
        db.exec(q)
      },
    }
    expect(() => ensureHistorySearchColumns(wrapped)).not.toThrow()
    expect(columnNames(db, "history_fts").has("kind")).toBe(true)
    expect(() => runSql(db, migrationSql("20261011000000_history_fts_kind"))).not.toThrow()
    expect(() => runSql(db, migrationSql("20261012000000_history_cjk_unigram"))).not.toThrow()

    // Journal seed is once-only (INSERT OR IGNORE).
    expect(() => runSql(db, migrationSql("20261011000000_history_fts_kind"))).not.toThrow()
    const v7 = db.prepare(`SELECT count(*) AS n FROM history_index_migration WHERE version=7`).get() as { n: number }
    expect(v7.n).toBe(1)
    db.close()
  })

  test("reverse desync: journal has name, kind missing → ensure restores column", () => {
    const db = baseDb()
    db.exec(`
      INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
      VALUES ('', 0, '20261011000000_history_fts_kind', 'x');
    `)
    const wrapped = {
      client: { prepare: (sql: string) => ({ all: () => db.prepare(sql).all() as never }) },
      run: (q: string) => {
        db.exec(q)
      },
    }
    ensureHistorySearchColumns(wrapped)
    const cols = columnNames(db, "history_fts")
    expect(cols.has("kind")).toBe(true)
    expect(cols.has("body_idx")).toBe(true)
    // replay is a no-op for columns
    expect(() => ensureHistorySearchColumns(wrapped)).not.toThrow()
    db.close()
  })

  test("fresh-ish: no kind yet, migrations + ensure yield search columns", () => {
    const db = baseDb()
    const wrapped = {
      client: { prepare: (sql: string) => ({ all: () => db.prepare(sql).all() as never }) },
      run: (q: string) => {
        db.exec(q)
      },
    }
    ensureHistorySearchColumns(wrapped)
    expect(columnNames(db, "history_fts").has("kind")).toBe(true)
    expect(() => runSql(db, migrationSql("20261011000000_history_fts_kind"))).not.toThrow()
    expect(() => runSql(db, migrationSql("20261012000000_history_cjk_unigram"))).not.toThrow()
    db.close()
  })
})
