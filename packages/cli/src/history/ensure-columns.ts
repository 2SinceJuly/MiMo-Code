/**
 * Schema probes for idempotent history FTS migrations.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`. Stuck clients can have the column
 * while `__drizzle_migrations` is missing the folder name (SKIP_MIGRATIONS wrote
 * `select 1`, name backfill mis-attributed, or a rolled-back DDL). Replaying
 * bare `ALTER TABLE ... ADD COLUMN` then aborts migrate() forever.
 *
 * Run before and after `migrate()`:
 * - before: tolerate journal/schema desync where columns already exist
 * - after: CREATE migrations may DROP kind (20260914); re-add for the search path
 */
export type EnsureDb = {
  run: (query: string) => unknown
  /** Raw driver handle (drizzle `$client` or bun/node sqlite). */
  client: { prepare: (sql: string) => { all: () => unknown[] } }
}

export function historyFtsColumns(db: EnsureDb, table = "history_fts"): Set<string> {
  try {
    const rows = db.client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
    return new Set(rows.map((r) => String(r.name ?? "")).filter(Boolean))
  } catch {
    return new Set()
  }
}

/** Add history search columns and kind index only when missing. */
export function ensureHistorySearchColumns(db: EnsureDb): void {
  const cols = historyFtsColumns(db)
  if (!cols.has("part_id")) return // table not created yet; CREATE migrations own it
  if (!cols.has("kind")) {
    db.run(`ALTER TABLE history_fts ADD COLUMN kind text NOT NULL DEFAULT ''`)
  }
  if (!cols.has("body_idx")) {
    db.run(`ALTER TABLE history_fts ADD COLUMN body_idx text NOT NULL DEFAULT ''`)
  }
  db.run(`CREATE INDEX IF NOT EXISTS history_fts_kind_idx ON history_fts (kind)`)
}
