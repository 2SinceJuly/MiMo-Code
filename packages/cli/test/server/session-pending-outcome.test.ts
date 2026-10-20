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
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })
afterEach(async () => { mock.restore(); await Instance.disposeAll() })
const model = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }

describe("pending input failure boundary", () => {
  // [TP-RUN-R1C-08] Real preparation/registration, pre-history failure, shared delivery and HTTP recovery.
  for (const order of ["forward", "reverse", "wake-first", "wake-last"] as const) {
    test(`${order} pending selects the latest persisted user before reading history and remains resumable`, async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        { lines: textStopResponse("resumed merged input") },
        { lines: textStopResponse("later send succeeded") },
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
          const session = yield* sessions.create({ title: "pending preparation failure" })
          const aID = MessageID.ascending()
          const bID = MessageID.ascending()
          const cID = MessageID.ascending()
          const entered = yield* Deferred.make<void>()
          const releaseCurrent = yield* Deferred.make<void>()
          const releaseOlder = yield* Deferred.make<void>()
          const olderPrepared = yield* Deferred.make<void>()
          const registrations = Array.from({ length: 4 }, () => Deferred.makeUnsafe<void>())
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
              return yield* Effect.die(new Error("pre-history initialization failed"))
            })
          })
          const send = (id: MessageID, text: string) => prompt.prompt({ sessionID: session.id,
            messageID: id, agent: "build", model, parts: [{ type: "text", text }] })
          const a = yield* send(aID, "original input").pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          yield* Deferred.await(registrations[0]!)
          const touch = sessions.touch
          let holdOlder = order === "reverse"
          const held = spyOn(sessions, "touch").mockImplementation((id) => {
            if (!holdOlder || id !== session.id) return touch(id)
            holdOlder = false
            return Deferred.succeed(olderPrepared, undefined).pipe(
              Effect.andThen(Deferred.await(releaseOlder)), Effect.andThen(touch(id)),
            )
          })
          const wake = order === "wake-first"
            ? yield* prompt.loop({ sessionID: session.id, source: "spawn" }).pipe(Effect.forkChild)
            : undefined
          if (wake) yield* Deferred.await(registrations[1]!)
          const b = yield* send(bID, "older added instruction").pipe(Effect.forkChild)
          if (order === "reverse") yield* Deferred.await(olderPrepared)
          else yield* Deferred.await(registrations[wake ? 2 : 1]!)
          const c = yield* send(cID, "latest added instruction").pipe(Effect.forkChild)
          yield* Deferred.await(registrations[order === "reverse" ? 1 : wake ? 3 : 2]!)
          if (order === "reverse") {
            yield* Deferred.succeed(releaseOlder, undefined)
            yield* Deferred.await(registrations[2]!)
          }
          // A later generic loop must also retain C's persisted ownership.
          const laterWake = order === "wake-last"
            ? yield* prompt.loop({ sessionID: session.id, source: "spawn" }).pipe(Effect.forkChild)
            : undefined
          if (laterWake) yield* Deferred.await(registrations[3]!)
          held.mockRestore()
          const users = (yield* sessions.messages({ sessionID: session.id })).filter(m => m.info.role === "user")
          expect(users.map(m => m.info.id)).toEqual([aID, bID, cID])
          yield* Deferred.succeed(releaseCurrent, undefined)
          const first = yield* Fiber.join(a)
          const second = yield* Fiber.join(b)
          const third = yield* Fiber.join(c)
          if (wake) expect(yield* Fiber.join(wake)).toEqual(third)
          if (laterWake) expect(yield* Fiber.join(laterWake)).toEqual(third)
          registered.mockRestore(); prelude.mockRestore()
          expect(first.info).toMatchObject({ parentID: aID, error: { data: { message: "pre-history initialization failed" } } })
          expect(second).toEqual(third)
          expect(third.info).toMatchObject({ parentID: cID, time: { completed: expect.any(Number) },
            error: { data: { message: "pre-history initialization failed" } } })
          const after = yield* sessions.messages({ sessionID: session.id })
          expect(after.filter(m => m.info.role === "assistant" && m.info.error).map(m => m.info.role === "assistant" && m.info.parentID)).toEqual([aID, cID])
          expect(yield* status.get(session.id)).toEqual({ type: "idle" })
          expect(stub.captures).toHaveLength(0)
          const app = Server.Default().app
          const query = `?directory=${encodeURIComponent(tmp.path)}`
          const listed = yield* Effect.promise(() => Promise.resolve(app.request(`/session/${session.id}/recovery${query}`)))
          expect(listed.status).toBe(200)
          expect(yield* Effect.promise(() => listed.json())).toMatchObject([
            { kind: "assistant", assistantMessageID: third.info.id, parentMessageID: cID },
          ])
          const resumed = yield* Effect.promise(() => Promise.resolve(app.request(`/session/${session.id}/resume${query}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assistantMessageID: third.info.id }),
          })))
          expect(resumed.status).toBe(202)
          for (let i = 0; i < 100; i++) {
            if ((yield* status.get(session.id)).type === "idle" && (yield* sessions.messages({ sessionID: session.id })).some(m => m.parts.some(p => p.type === "text" && p.text === "resumed merged input"))) break
            yield* Effect.sleep("20 millis")
          }
          expect(yield* status.get(session.id)).toEqual({ type: "idle" })
          const resumedMessages = yield* sessions.messages({ sessionID: session.id })
          expect(resumedMessages.some(m => m.info.role === "assistant" && m.info.parentID === cID && !m.info.error && m.parts.some(p => p.type === "text" && p.text === "resumed merged input"))).toBe(true)
          const next = yield* send(MessageID.ascending(), "next independent input")
          expect(next.info.role === "assistant" && next.info.error).toBeUndefined()
          expect(next.parts.some(p => p.type === "text" && p.text === "later send succeeded")).toBe(true)
          expect(stub.captures).toHaveLength(2)
        })) })
      } finally { stub.stop() }
    })
  }
})
