import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Logger } from "effect"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { SessionPrefixSnapshot } from "../../src/session/prefix-snapshot"
import { MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import { Database, sql } from "../../src/storage"

describe("session prefix snapshot", () => {
  // [TP-RUN-R1C-10] Cache failures never commit a new watermark and invalidate only the affected snapshot.
  for (const boundary of ["before-update", "after-update", "invalidation"] as const) {
    test(`${boundary} failure retains a safe boundary and permits rebuilding`, async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await AppRuntime.runPromise(SessionNs.Service.use((service) => service.create({})))
          const input = {
            sessionID: session.id,
            profileKey: "cache-failure",
            system: ["frozen"],
            toolsHash: "tools",
            tools: [],
            watermarkMessageID: MessageID.ascending(),
          }
          const before = await AppRuntime.runPromise(SessionPrefixSnapshot.pin(input))
          Database.use((db) => {
            db.run(
              sql.raw(
                `CREATE TEMP TRIGGER fail_watermark ${boundary === "after-update" ? "AFTER" : "BEFORE"} UPDATE OF watermark_message_id ON session_prefix_snapshot BEGIN SELECT RAISE(FAIL, 'watermark write failed'); END`,
              ),
            )
            if (boundary === "invalidation")
              db.run(
                sql`CREATE TEMP TRIGGER fail_invalidation BEFORE DELETE ON session_prefix_snapshot BEGIN SELECT RAISE(FAIL, 'cache invalidation failed'); END`,
              )
          })
          try {
            await AppRuntime.runPromise(
              SessionPrefixSnapshot.advance({
                ...input,
                revision: before.revision,
                watermarkMessageID: MessageID.ascending(),
              }),
            )
            const after = await AppRuntime.runPromise(SessionPrefixSnapshot.get(session.id, input.profileKey))
            if (boundary === "invalidation") expect(after).toEqual(before)
            else expect(after).toBeUndefined()
          } finally {
            Database.use((db) => {
              db.run(sql`DROP TRIGGER IF EXISTS fail_watermark`)
              db.run(sql`DROP TRIGGER IF EXISTS fail_invalidation`)
            })
          }
          const rebuilt = await AppRuntime.runPromise(SessionPrefixSnapshot.rotate({ ...input, system: ["rebuilt"] }))
          expect(rebuilt.system).toEqual(["rebuilt"])
          await AppRuntime.runPromise(
            SessionPrefixSnapshot.advance({
              ...input,
              revision: rebuilt.revision,
              watermarkMessageID: input.watermarkMessageID,
            }),
          )
          expect(
            (await AppRuntime.runPromise(SessionPrefixSnapshot.get(session.id, input.profileKey)))
              ?.watermark_message_id,
          ).toBe(input.watermarkMessageID)
        },
      })
    })
  }

  // [TP-RUN-R1C-10] A newer revision registered during failure handling cannot be invalidated by old work.
  test("failed old revision leaves a concurrently rotated snapshot intact", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(SessionNs.Service.use((service) => service.create({})))
        const input = {
          sessionID: session.id,
          profileKey: "revision-ownership",
          system: ["first"],
          toolsHash: "tools",
          tools: [],
          watermarkMessageID: MessageID.ascending(),
        }
        const before = await AppRuntime.runPromise(SessionPrefixSnapshot.pin(input))
        Database.use((db) =>
          db.run(
            sql`CREATE TEMP TRIGGER fail_old_revision BEFORE UPDATE OF watermark_message_id ON session_prefix_snapshot WHEN OLD.revision = NEW.revision BEGIN SELECT RAISE(FAIL, 'old revision failure'); END`,
          ),
        )
        let rotated = false
        const newerWatermark = MessageID.ascending()
        try {
          await AppRuntime.runPromise(
            SessionPrefixSnapshot.advance({
              ...input,
              revision: before.revision,
              watermarkMessageID: MessageID.ascending(),
            }).pipe(
              Effect.provide(
                Logger.layer([
                  Logger.make((options) => {
                    if (String(options.message) !== "prefix watermark advance failed" || rotated) return
                    rotated = true
                    // The diagnostic yields before invalidation, allowing another work owner to rotate.
                    Database.use((db) =>
                      db.run(
                        sql`UPDATE session_prefix_snapshot SET revision = revision + 1, watermark_message_id = ${newerWatermark} WHERE session_id = ${session.id} AND profile_key = ${input.profileKey}`,
                      ),
                    )
                  }),
                ]),
              ),
            ),
          )
          expect(rotated).toBe(true)
          expect(await AppRuntime.runPromise(SessionPrefixSnapshot.get(session.id, input.profileKey))).toMatchObject({
            revision: before.revision + 1,
            watermark_message_id: newerWatermark,
          })
        } finally {
          Database.use((db) => db.run(sql`DROP TRIGGER fail_old_revision`))
        }
      },
    })
  })

  test("pins, rotates, advances, and cascades with its session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(SessionNs.Service.use((service) => service.create({})))
        const key = SessionPrefixSnapshot.profileKey({
          providerID: "test",
          modelID: "test-model",
          agent: "build",
          agentID: "main",
          harness: "auto",
          systemMode: "append",
          system: "",
          permission: [],
        })
        const firstWatermark = MessageID.ascending()
        const first = await AppRuntime.runPromise(
          SessionPrefixSnapshot.pin({
            sessionID: session.id,
            profileKey: key,
            system: ["first"],
            toolsHash: "tools-1",
            tools: [],
            watermarkMessageID: firstWatermark,
          }),
        )
        expect(first).toMatchObject({
          revision: 1,
          system: ["first"],
          tools_hash: "tools-1",
          watermark_message_id: firstWatermark,
        })

        const pinned = await AppRuntime.runPromise(
          SessionPrefixSnapshot.pin({
            sessionID: session.id,
            profileKey: key,
            system: ["ignored"],
            toolsHash: "ignored",
            tools: [],
            watermarkMessageID: MessageID.ascending(),
          }),
        )
        expect(pinned).toEqual(first)

        const rotated = await AppRuntime.runPromise(
          SessionPrefixSnapshot.rotate({
            sessionID: session.id,
            profileKey: key,
            system: ["second"],
            toolsHash: "tools-2",
            tools: [],
            watermarkMessageID: firstWatermark,
          }),
        )
        expect(rotated).toMatchObject({ revision: 2, system: ["second"], tools_hash: "tools-2" })

        const finalWatermark = MessageID.ascending()
        await AppRuntime.runPromise(
          SessionPrefixSnapshot.advance({
            sessionID: session.id,
            profileKey: key,
            revision: 1,
            watermarkMessageID: MessageID.ascending(),
          }),
        )
        await AppRuntime.runPromise(
          SessionPrefixSnapshot.advance({
            sessionID: session.id,
            profileKey: key,
            revision: 2,
            watermarkMessageID: finalWatermark,
          }),
        )
        expect(await AppRuntime.runPromise(SessionPrefixSnapshot.get(session.id, key))).toMatchObject({
          revision: 2,
          watermark_message_id: finalWatermark,
        })

        await AppRuntime.runPromise(SessionNs.Service.use((service) => service.remove(session.id)))
        expect(await AppRuntime.runPromise(SessionPrefixSnapshot.get(session.id, key))).toBeUndefined()
      },
    })
  })

  test("profile and tool hashes are stable across key order", () => {
    const permission = [{ permission: "*", pattern: "*", action: "allow" as const }]
    const key = SessionPrefixSnapshot.profileKey({
      providerID: "p",
      modelID: "m",
      agent: "build",
      agentID: "main",
      harness: "auto",
      systemMode: "append",
      system: "",
      permission,
    })
    expect(key).toBe(
      SessionPrefixSnapshot.profileKey({
        permission,
        systemMode: "append",
        system: "",
        harness: "auto",
        agentID: "main",
        agent: "build",
        modelID: "m",
        providerID: "p",
      }),
    )
    expect(key).not.toBe(
      SessionPrefixSnapshot.profileKey({
        providerID: "p",
        modelID: "other",
        agent: "build",
        agentID: "main",
        harness: "auto",
        systemMode: "append",
        system: "",
        permission,
      }),
    )
    const first = {
      beta: tool({ description: "b", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
      alpha: tool({ description: "a", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
    }
    const second = { alpha: first.alpha, beta: first.beta }
    expect(SessionPrefixSnapshot.toolsHash(first, ["beta", "alpha"])).toBe(
      SessionPrefixSnapshot.toolsHash(second, ["alpha", "beta"]),
    )
  })
})
