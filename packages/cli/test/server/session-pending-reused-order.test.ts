import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { MessageID } from "../../src/session/schema"
import { MessageTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })
afterEach(async () => { mock.restore(); await Instance.disposeAll() })
const model = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }

describe("pending ownership with a reused persisted message", () => {
  // [TP-RUN-R1C-08] Upsert keeps SQL ordering while the new message payload has a later timestamp.
  for (const reverseRegistration of [false, true]) test(`reused older ID cannot replace the latest persisted user (reverse=${reverseRegistration})`, async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: textStopResponse("recovered newest input") },
      { lines: textStopResponse("subsequent send succeeded") },
    ])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify({ enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } } },
        agent: { build: { model: "alibaba/qwen-plus" } }, checkpoint: { thresholds: [] } }))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const state = yield* SessionRunState.Service
        const plugin = yield* Plugin.Service
        const status = yield* SessionStatus.Service
        const session = yield* sessions.create({ title: "reused pending identity" })
        const bID = MessageID.ascending(), aID = MessageID.ascending(), cID = MessageID.ascending()
        const send = (id: MessageID, text: string, noReply = false) => prompt.prompt({ sessionID: session.id,
          messageID: id, noReply, agent: "build", model, parts: [{ type: "text", text }] })
        const seed = yield* send(bID, "historical input", true)
        const originalCreated = Database.use(db => db.select({ created: MessageTable.time_created }).from(MessageTable).where(eq(MessageTable.id, bID)).get())!.created
        yield* Effect.sleep("5 millis")
        const entered = yield* Deferred.make<void>(), releaseCurrent = yield* Deferred.make<void>()
        const newPrepared = yield* Deferred.make<void>(), releaseNew = yield* Deferred.make<void>()
        const registrations = Array.from({ length: 3 }, () => Deferred.makeUnsafe<void>())
        let count = 0
        const ensure = state.ensureRunning
        const registered = spyOn(state, "ensureRunning").mockImplementation((...args) => ensure(
          args[0], args[1], args[2], args[3], () => {
            args[4]?.()
            Deferred.doneUnsafe(registrations[count++]!, Effect.void)
          }, args[5],
        ))
        let preCount = 0
        const trigger = plugin.trigger
        const prelude = spyOn(plugin, "trigger").mockImplementation((...args) => {
          if (args[0] !== "session.pre") return trigger(...args)
          return Effect.gen(function* () {
            if (preCount++ === 0) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(releaseCurrent)
            }
            return yield* Effect.die(new Error("initialization before history failed"))
          })
        })
        const a = yield* send(aID, "active input").pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Deferred.await(registrations[0]!)
        yield* Effect.sleep("5 millis")
        const touch = sessions.touch
        let holdNew = reverseRegistration
        const held = spyOn(sessions, "touch").mockImplementation((id) => {
          if (!holdNew || id !== session.id) return touch(id)
          holdNew = false
          return Deferred.succeed(newPrepared, undefined).pipe(Effect.andThen(Deferred.await(releaseNew)), Effect.andThen(touch(id)))
        })
        const c = yield* send(cID, "newest persisted input").pipe(Effect.forkChild)
        if (reverseRegistration) yield* Deferred.await(newPrepared)
        else yield* Deferred.await(registrations[1]!)
        yield* Effect.sleep("5 millis")
        const b = yield* send(bID, "updated historical input").pipe(Effect.forkChild)
        yield* Deferred.await(registrations[reverseRegistration ? 1 : 2]!)
        if (reverseRegistration) {
          yield* Deferred.succeed(releaseNew, undefined)
          yield* Deferred.await(registrations[2]!)
        }
        held.mockRestore()
        const before = yield* sessions.messages({ sessionID: session.id })
        const reused = before.find(m => m.info.id === bID)!
        const latest = before.find(m => m.info.id === cID)!
        expect(before.filter(m => m.info.role === "user").map(m => m.info.id)).toEqual([bID, aID, cID])
        expect(reused.info.time.created).toBeGreaterThan(latest.info.time.created)
        expect(Database.use(db => db.select({ created: MessageTable.time_created }).from(MessageTable).where(eq(MessageTable.id, bID)).get())!.created).toBe(originalCreated)
        expect(seed.info.id).toBe(bID)
        yield* Deferred.succeed(releaseCurrent, undefined)
        const first = yield* Fiber.join(a), reusedResult = yield* Fiber.join(b), newestResult = yield* Fiber.join(c)
        registered.mockRestore(); prelude.mockRestore()
        expect(first.info).toMatchObject({ parentID: aID, error: { data: { message: "initialization before history failed" } } })
        expect(reusedResult).toEqual(newestResult)
        expect(newestResult.info).toMatchObject({ parentID: cID, time: { completed: expect.any(Number) },
          error: { data: { message: "initialization before history failed" } } })
        const after = yield* sessions.messages({ sessionID: session.id })
        expect(after.filter(m => m.info.role === "assistant" && m.info.error).map(m => m.info.role === "assistant" && m.info.parentID)).toEqual([aID, cID])
        expect(yield* status.get(session.id)).toEqual({ type: "idle" })
        expect(stub.captures).toHaveLength(0)
        const app = Server.Default().app
        const query = `?directory=${encodeURIComponent(tmp.path)}`
        const recovery = yield* Effect.promise(() => Promise.resolve(app.request(`/session/${session.id}/recovery${query}`)))
        expect(recovery.status).toBe(200)
        expect(yield* Effect.promise(() => recovery.json())).toMatchObject([
          { kind: "assistant", assistantMessageID: newestResult.info.id, parentMessageID: cID },
        ])
        const resumed = yield* Effect.promise(() => Promise.resolve(app.request(`/session/${session.id}/resume${query}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assistantMessageID: newestResult.info.id }),
        })))
        expect(resumed.status).toBe(202)
        for (let i = 0; i < 100; i++) {
          if ((yield* status.get(session.id)).type === "idle" && (yield* sessions.messages({ sessionID: session.id })).some(m => m.parts.some(p => p.type === "text" && p.text === "recovered newest input"))) break
          yield* Effect.sleep("20 millis")
        }
        expect(yield* status.get(session.id)).toEqual({ type: "idle" })
        expect((yield* sessions.messages({ sessionID: session.id })).some(m => m.info.role === "assistant" && m.info.parentID === cID && !m.info.error && m.parts.some(p => p.type === "text" && p.text === "recovered newest input"))).toBe(true)
        const next = yield* send(MessageID.ascending(), "new independent input")
        expect(next.info.role === "assistant" && next.info.error).toBeUndefined()
        expect(next.parts.some(p => p.type === "text" && p.text === "subsequent send succeeded")).toBe(true)
        expect(stub.captures).toHaveLength(2)
      })) })
    } finally { stub.stop() }
  })
})
