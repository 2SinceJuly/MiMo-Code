// [fix] replaying history kind migrations must not abort on a desynced journal.
// DDL stays in migration/*.sql; migrateReplaySafe only skips replay-safe no-ops.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { migrateReplaySafe, type MigrationEntry, type ReplaySafeDb } from "../../src/storage/migrate-replay-safe"

function entry(name: string): MigrationEntry {
  return {
    sql: readFileSync(join(import.meta.dir, "../../migration", name, "migration.sql"), "utf8"),
    timestamp: 1,
    name,
  }
}

function wrap(db: Database): ReplaySafeDb {
  return {
    run: (q) => {
      db.run(q)
    },
    client: {
      prepare: (sql) => ({
        all: () => db.prepare(sql).all(),
        get: () => db.prepare(sql).get(),
      }),
    },
  }
}

function columnNames(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

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
  `)
  return db
}

const KIND_SQL = entry("20261011000000_history_fts_kind")
const CJK_SQL = entry("20261012000000_history_cjk_unigram")

describe("history FTS kind migrations are replay-safe", () => {
  test("stuck client: kind exists, 20261011 unjournaled → replay succeeds", () => {
    const db = baseDb()
    db.exec(`ALTER TABLE history_fts ADD COLUMN kind text NOT NULL DEFAULT ''`)
    // Old bare ALTER was the production abort:
    expect(() => db.exec(`ALTER TABLE history_fts ADD COLUMN kind text NOT NULL DEFAULT ''`)).toThrow(
      /duplicate column name/i,
    )
    expect(() => migrateReplaySafe(wrap(db), [KIND_SQL, CJK_SQL])).not.toThrow()
    expect(columnNames(db, "history_fts").has("kind")).toBe(true)
    expect(columnNames(db, "history_fts").has("body_idx")).toBe(true)
    // second replay is a no-op except journal is already recorded
    expect(() => migrateReplaySafe(wrap(db), [KIND_SQL, CJK_SQL])).not.toThrow()
    const v7 = db.prepare(`SELECT count(*) AS n FROM history_index_migration WHERE version=7`).get() as { n: number }
    expect(v7.n).toBe(1)
    db.close()
  })

  test("reverse desync: journal has name, kind missing → replay is skipped", () => {
    const db = baseDb()
    migrateReplaySafe(wrap(db), [KIND_SQL])
    // Drop column then re-add name as applied without re-running DDL — simulate
    // journal ahead of schema: runner skips because name is journaled.
    db.exec(`DROP INDEX IF EXISTS history_fts_kind_idx`)
    db.exec(`ALTER TABLE history_fts DROP COLUMN kind`)
    expect(() => migrateReplaySafe(wrap(db), [KIND_SQL])).not.toThrow()
    // skipped (name journaled) — column stays missing; that is ledger-truthful
    expect(columnNames(db, "history_fts").has("kind")).toBe(false)
    db.close()
  })

  test("fresh: DDL runs once from migration SQL", () => {
    const db = baseDb()
    migrateReplaySafe(wrap(db), [KIND_SQL, CJK_SQL])
    const cols = columnNames(db, "history_fts")
    expect(cols.has("kind")).toBe(true)
    expect(cols.has("body_idx")).toBe(true)
    db.close()
  })
})
