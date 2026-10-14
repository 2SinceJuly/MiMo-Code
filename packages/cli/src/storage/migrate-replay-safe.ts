/**
 * Replay-safe schema migrations.
 *
 * DDL stays in migration/*.sql (schema = sum of migrations). This runner keeps
 * that model and only refuses to abort when a statement is a no-op against the
 * current schema: ALTER ADD COLUMN on a column that already exists, ALTER DROP
 * COLUMN on a column that is gone, CREATE INDEX that already exists. Those are
 * journal/schema desync replays, not logic errors.
 */
export type ReplaySafeDb = {
  run: (query: string) => unknown
  client: { prepare: (sql: string) => { all: () => unknown[]; get: () => unknown } }
}

export type MigrationEntry = { sql: string; timestamp: number; name: string }

const MIGRATIONS_TABLE = "__drizzle_migrations"

function errorMessage(error: unknown): string {
  const parts: string[] = []
  let cur: unknown = error
  for (let i = 0; i < 5 && cur != null; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message)
      cur = (cur as { cause?: unknown }).cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join(" | ")
}

/** Strip leading `--` comment lines so DDL kind is visible after file headers. */
function ddlKind(statement: string): string {
  return statement
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trimStart()
}

/** Only these statement+error pairs are "already applied / already gone". */
export function isReplaySafeDdl(statement: string, error: unknown): boolean {
  const s = ddlKind(statement)
  const msg = errorMessage(error)
  if (/^alter\s+table/i.test(s)) {
    return /duplicate column name/i.test(msg) || /no such column/i.test(msg)
  }
  if (/^create\s+(unique\s+)?index/i.test(s)) {
    return /already exists/i.test(msg)
  }
  return false
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean)
}

function ensureJournalTable(db: ReplaySafeDb): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )`,
  )
}

function journaledNames(db: ReplaySafeDb): Set<string> {
  const rows = db.client
    .prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`)
    .all() as Array<{ name?: string | null }>
  return new Set(rows.map((r) => r.name).filter((n): n is string => !!n))
}

/**
 * Run pending migrations in order. Statements that are replay-safe no-ops do
 * not fail the migration; the journal row is still written so the name is not
 * retried forever.
 */
export function migrateReplaySafe(db: ReplaySafeDb, entries: readonly MigrationEntry[]): string[] {
  ensureJournalTable(db)
  const done = journaledNames(db)
  const pending = entries.filter((e) => e.name && !done.has(e.name))
  if (!pending.length) return []

  db.run("BEGIN")
  try {
    for (const migration of pending) {
      for (const stmt of splitStatements(migration.sql)) {
        try {
          db.run(stmt)
        } catch (error) {
          if (!isReplaySafeDdl(stmt, error)) throw error
        }
      }
      db.run(
        `INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at, name, applied_at)
         VALUES ('', ${Number(migration.timestamp) || 0}, '${migration.name.replace(/'/g, "''")}', '${new Date().toISOString()}')`,
      )
    }
    db.run("COMMIT")
  } catch (error) {
    db.run("ROLLBACK")
    throw error
  }
  return pending.map((m) => m.name)
}
