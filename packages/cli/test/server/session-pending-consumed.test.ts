import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider"
import { Goal } from "../../src/session/goal"
import { InboxTable } from "../../src/inbox"
import { Database } from "../../src/storage"
import { MessageID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })
afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})
const model = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }

// [TP-RUN-R1C-08] An active owner may consume pending input before the pending wake starts.
for (const outcome of [
  "success",
  "error",
  "provider-error",
  "length",
  "tool",
  "empty",
  "newer",
  "inbox",
  "goal",
  "reuse",
] as const)
  test(`consumed pending wake checks ${outcome} eligibility before starting another prelude`, async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: toolCallResponse({ id: "call-pending", name: "todowrite", args: JSON.stringify({ todos: [] }) }) },
      outcome === "provider-error"
        ? {
            status: 403,
            lines: [JSON.stringify({ error: { message: "provider denied the consumed input", type: "forbidden" } })],
          }
        : { lines: textStopResponse("the current owner answered the pending question") },
    ])
    try {
      await Bun.write(
        `${tmp.path}/mimocode.json`,
        JSON.stringify({
          enabled_providers: ["alibaba"],
          provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } } },
          agent: { build: { model: "alibaba/qwen-plus" } },
          checkpoint: { thresholds: [] },
        }),
      )
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const runState = yield* SessionRunState.Service
              const plugin = yield* Plugin.Service
              const goal = yield* Goal.Service
              const session = yield* sessions.create({ title: "pending already consumed" })
              const bID = MessageID.ascending()
              if (outcome === "reuse")
                yield* prompt.prompt({
                  sessionID: session.id,
                  messageID: bID,
                  agent: "build",
                  model,
                  noReply: true,
                  parts: [{ type: "text", text: "an existing input with this identity" }],
                })
              // A second prompt keeps the reused ID newest, while its prior existence remains observable.
              const aID = MessageID.ascending()
              let reached!: () => void
              const firstStep = new Promise<void>((resolve) => {
                reached = resolve
              })
              let release!: () => void
              const stepGate = new Promise<void>((resolve) => {
                release = resolve
              })
              let registered!: () => void
              const pendingRegistered = new Promise<void>((resolve) => {
                registered = resolve
              })
              let registrations = 0
              const ensure = runState.ensureRunning
              spyOn(runState, "ensureRunning").mockImplementation((sid, aid, interrupt, work, callback, order) =>
                ensure(
                  sid,
                  aid,
                  interrupt,
                  work,
                  () => {
                    callback?.()
                    if (++registrations === 2) registered()
                  },
                  order,
                ),
              )
              const trigger = plugin.trigger
              let posts = 0
              spyOn(plugin, "trigger").mockImplementation((name, input, output) => {
                if (name === "session.userQuery.post" && ++posts === 1)
                  return Effect.sync(reached).pipe(
                    Effect.andThen(Effect.promise(() => stepGate)),
                    Effect.andThen(trigger(name, input, output)),
                  )
                if (name === "session.post")
                  return Effect.gen(function* () {
                    const answer = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                    if (answer.info.role !== "assistant") throw new Error("Expected the active owner's answer")
                    if (outcome === "length" || outcome === "tool")
                      yield* sessions.updateMessage({
                        ...answer.info,
                        finish: outcome === "length" ? "length" : "tool-calls",
                      })
                    if (outcome === "empty")
                      for (const part of answer.parts)
                        if (part.type === "text") yield* sessions.updatePart({ ...part, text: "" })
                    if (outcome === "newer")
                      yield* prompt.prompt({
                        sessionID: session.id,
                        agent: "build",
                        model,
                        noReply: true,
                        parts: [{ type: "text", text: "new work must not be skipped" }],
                      })
                    if (outcome === "inbox")
                      Database.use((db) =>
                        db
                          .insert(InboxTable)
                          .values({
                            id: "pending-consumed-inbox",
                            receiver_session_id: session.id,
                            receiver_actor_id: "main",
                            type: "text",
                            content: { text: "still pending" },
                            created_at: Date.now(),
                          })
                          .run(),
                      )
                    if (outcome === "goal") yield* goal.set(session.id, "still an active goal")
                    spyOn(sessions, "resolvePrompt").mockImplementation(() =>
                      Effect.die(new Error("redundant wake prelude failed")),
                    )
                    return yield* trigger(name, input, output)
                  })
                return trigger(name, input, output)
              })
              const a = yield* prompt
                .prompt({
                  sessionID: session.id,
                  messageID: outcome === "reuse" ? bID : aID,
                  agent: "build",
                  model,
                  parts: [{ type: "text", text: "do the first step, then continue" }],
                })
                .pipe(Effect.forkChild)
              yield* Effect.promise(() => firstStep)
              const b = yield* prompt
                .prompt({
                  sessionID: session.id,
                  messageID: bID,
                  agent: "build",
                  model,
                  parts: [{ type: "text", text: "answer this newer question" }],
                })
                .pipe(Effect.forkChild)
              yield* Effect.promise(() => pendingRegistered)
              if (outcome === "error") {
                const provider = yield* Provider.Service
                spyOn(provider, "getLanguage").mockImplementation(() =>
                  Effect.die(new Error("the actual owner failed")),
                )
              }
              release()
              const activeResult = yield* Fiber.join(a)
              const pendingResult = yield* Fiber.join(b)
              expect(activeResult.info).toMatchObject({ parentID: bID })
              if (activeResult.info.role !== "assistant") throw new Error("Expected the active owner's assistant")
              if (outcome === "provider-error") expect(activeResult.info.time.completed).toBeUndefined()
              else expect(activeResult.info.time.completed).toEqual(expect.any(Number))
              if (outcome === "error")
                expect(activeResult.info.role === "assistant" && activeResult.info.error).toMatchObject({
                  data: { message: "the actual owner failed" },
                })
              else if (outcome === "provider-error")
                expect(activeResult.info.role === "assistant" && activeResult.info.error).toMatchObject({
                  name: "APIError",
                  data: { statusCode: 403 },
                })
              else expect(activeResult.info.role === "assistant" && activeResult.info.error).toBeUndefined()
              if (outcome === "success" || outcome === "error" || outcome === "provider-error")
                expect(pendingResult).toEqual(activeResult)
              else
                expect(pendingResult.info).toMatchObject({
                  parentID: bID,
                  error: { data: { message: "redundant wake prelude failed" } },
                })
              const messages = yield* sessions.messages({ sessionID: session.id })
              expect(
                messages.filter((message) => message.info.role === "assistant" && message.info.error),
              ).toHaveLength(outcome === "success" ? 0 : 1)
              expect(stub.captures).toHaveLength(outcome === "error" ? 1 : 2)
              expect(yield* SessionStatus.Service.use((status) => status.get(session.id))).toEqual({ type: "idle" })
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  }, 30000)
