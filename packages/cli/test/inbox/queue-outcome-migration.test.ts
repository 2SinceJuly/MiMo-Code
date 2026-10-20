import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrateReplaySafe } from "../../src/storage/migrate-replay-safe"

const previous = await Bun.file(new URL("../../migration/20261013000000_inbox_queue/migration.sql", import.meta.url)).text()
const migrationPath = new URL("../../migration/20261020000000_inbox_outcome_anchor/migration.sql", import.meta.url)

function previousDatabase() {
  const sqlite = new Database(":memory:")
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE session (id text PRIMARY KEY);
    CREATE TABLE inbox (
      id text PRIMARY KEY, receiver_session_id text, receiver_actor_id text,
      sender_session_id text, sender_actor_id text, type text, content text, created_at integer
    );
    INSERT INTO session VALUES ('session-old');
  `)
  sqlite.exec(previous.replaceAll("--> statement-breakpoint", ""))
  sqlite.exec(`
    INSERT INTO inbox (id, receiver_session_id, state, input_message_id, created_at, time_updated)
      VALUES ('accepted', 'session-old', 'accepted', 'msg-A', 1, 1);
    INSERT INTO inbox (id, receiver_session_id, state, input_message_id, consumed, outcome, delivery_message_id, error, created_at, time_updated)
      VALUES ('settled', 'session-old', 'settled', 'msg-B', 1, 'assistant_error', 'msg-first', '403 quota', 2, 3);
  `)
  return sqlite
}

describe("Inbox outcome anchor migration", () => {
  test("[TP-RUN-R1C-08] upgrades the released queue schema without replaying or changing existing receipts", async () => {
    const sqlite = previousDatabase()
    try {
      const before = sqlite.query("SELECT * FROM inbox ORDER BY id").all() as Record<string, unknown>[]
      const sql = await Bun.file(migrationPath).text()
      const entries = [{ sql, timestamp: 20261020000000, name: "20261020000000_inbox_outcome_anchor" }]
      const db = drizzle({ client: sqlite })
      migrateReplaySafe(db as never, entries)
      expect(sqlite.query("SELECT * FROM inbox ORDER BY id").all()).toEqual(before.map((row) => ({ ...row, outcome_message_id: null })))
      // There is no result-message foreign key: history can be removed/cropped.
      sqlite.exec("UPDATE inbox SET outcome_message_id = 'msg-final-no-longer-in-history' WHERE id = 'settled'")
      migrateReplaySafe(db as never, entries)
      expect(sqlite.query("SELECT outcome_message_id FROM inbox WHERE id = 'settled'").get()).toEqual({ outcome_message_id: "msg-final-no-longer-in-history" })
      expect((sqlite.query("SELECT count(*) AS count FROM __drizzle_migrations").get() as { count: number }).count).toBe(1)
    } finally {
      sqlite.close()
    }
  })

  test("[TP-RUN-R1C-08] accepts an already-added column when the migration journal needs recovery", async () => {
    const sqlite = previousDatabase()
    try {
      const sql = await Bun.file(migrationPath).text()
      sqlite.exec(sql)
      sqlite.exec("UPDATE inbox SET outcome_message_id = 'msg-preserved' WHERE id = 'settled'")
      migrateReplaySafe(drizzle({ client: sqlite }) as never, [{ sql, timestamp: 20261020000000, name: "20261020000000_inbox_outcome_anchor" }])
      expect(sqlite.query("SELECT outcome_message_id FROM inbox WHERE id = 'settled'").get()).toEqual({ outcome_message_id: "msg-preserved" })
    } finally {
      sqlite.close()
    }
  })
})
