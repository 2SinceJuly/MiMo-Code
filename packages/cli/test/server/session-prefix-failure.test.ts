import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrefixSnapshot } from "../../src/session/prefix-snapshot"
import { SessionPrefixSnapshotTable } from "../../src/session/session.sql"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionStatus } from "../../src/session/status"
import { Plugin } from "../../src/plugin"
import { Bus } from "../../src/bus"
import { Database, eq, sql } from "../../src/storage"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import {
  emptyStopResponse,
  startScriptedLLMServer,
  textLengthResponse,
  textStopResponse,
  toolCallResponse,
} from "../lib/scripted-llm-server"

void Log.init({ print: false })
afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})
const model = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }

describe("session prefix failure ownership", () => {
  // [TP-RUN-R1C-10] Cache recovery leaves the outcome classifier in charge of incomplete work.
  for (const outcome of ["length", "empty", "tool"] as const) {
    test(`${outcome} continues despite cache maintenance failure`, async () => {
      await using tmp = await tmpdir({ git: true })
      const initial =
        outcome === "length"
          ? textLengthResponse("partial response")
          : outcome === "empty"
            ? emptyStopResponse()
            : toolCallResponse({ id: "call-prefix", name: "todowrite", args: JSON.stringify({ todos: [] }) })
      const stub = startScriptedLLMServer([
        { lines: initial },
        { lines: textStopResponse("classified continuation succeeded") },
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
                const session = yield* sessions.create({ title: "outcome remains authoritative" })
                Database.use((db) =>
                  db.run(
                    sql`CREATE TEMP TRIGGER reject_classification_watermark BEFORE UPDATE OF watermark_message_id ON session_prefix_snapshot BEGIN SELECT RAISE(FAIL, 'cache maintenance failed'); END`,
                  ),
                )
                try {
                  const response = yield* Effect.promise(() =>
                    Promise.resolve(
                      Server.Default().app.request(
                        `/session/${session.id}/message?directory=${encodeURIComponent(tmp.path)}`,
                        {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            agent: "build",
                            model,
                            parts: [{ type: "text", text: "answer with the requested result" }],
                          }),
                        },
                      ),
                    ),
                  )
                  expect(response.status).toBe(200)
                  const body = yield* Effect.promise(() => response.json())
                  expect(body.info.error).toBeUndefined()
                  expect(
                    body.parts.some((part: { text?: string }) => part.text === "classified continuation succeeded"),
                  ).toBe(true)
                  expect(stub.captures).toHaveLength(2)
                  const assistants = (yield* sessions.messages({ sessionID: session.id })).filter(
                    (message) => message.info.role === "assistant",
                  )
                  // The existing empty-residue sweep removes empty shells;
                  // cache recovery still must retain the real final answer.
                  expect(assistants).toHaveLength(outcome === "empty" ? 1 : 2)
                  if (outcome !== "empty") expect(assistants[0].info.role === "assistant" && assistants[0].info.finish).toBe(
                    outcome === "tool" ? "tool-calls" : "length",
                  )
                  expect(assistants.some((message) => message.info.role === "assistant" && !!message.info.error)).toBe(
                    false,
                  )
                } finally {
                  Database.use((db) => db.run(sql`DROP TRIGGER reject_classification_watermark`))
                }
              }),
            ),
        })
      } finally {
        await stub.stop()
      }
    }, 30000)
  }

  // [TP-RUN-R1C-10] A failed derived cache write preserves the real answer, HTTP result, and history.
  for (const route of ["message", "prompt_async"] as const) {
    test(`${route} preserves success after a real watermark write failure and rebuilds the cache`, async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([
        { lines: textStopResponse("first answer remains successful") },
        { lines: textStopResponse("next answer rebuilt the prefix") },
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
                const plugin = yield* Plugin.Service
                const session = yield* sessions.create({ title: "prefix maintenance" })
                const app = Server.Default().app
                let before: MessageV2.WithParts | undefined
                let installed = false
                let key = ""
                const originalTrigger = plugin.trigger
                spyOn(plugin, "trigger").mockImplementation((name, input, output) => {
                  if (name !== "session.userQuery.post" || installed) return originalTrigger(name, input, output)
                  return Effect.gen(function* () {
                    before = (yield* sessions.messages({ sessionID: session.id })).findLast(
                      (message) => message.info.role === "assistant",
                    )
                    if (!before || before.info.role !== "assistant") throw new Error("Expected the completed assistant")
                    expect(before.info.finish).toBe("stop")
                    expect(typeof before.info.time.completed).toBe("number")
                    expect(before.info.error).toBeUndefined()
                    key = Database.use((db) =>
                      db
                        .select()
                        .from(SessionPrefixSnapshotTable)
                        .where(eq(SessionPrefixSnapshotTable.session_id, session.id))
                        .get(),
                    )!.profile_key
                    Database.use((db) =>
                      db.run(
                        sql`CREATE TEMP TRIGGER reject_answer_watermark BEFORE UPDATE OF watermark_message_id ON session_prefix_snapshot BEGIN SELECT RAISE(FAIL, 'prefix bookkeeping failed'); END`,
                      ),
                    )
                    installed = true
                    return output
                  })
                })
                const errors: unknown[] = []
                const off = Bus.subscribe(Session.Event.Error, (event) => {
                  if (event.properties.sessionID === session.id) errors.push(event.properties.error)
                })
                try {
                  const send = (endpoint: string, text: string) =>
                    Promise.resolve(
                      app.request(`/session/${session.id}/${endpoint}?directory=${encodeURIComponent(tmp.path)}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ agent: "build", model, parts: [{ type: "text", text }] }),
                      }),
                    )
                  const response = yield* Effect.promise(() => send(route, "answer this normally"))
                  expect(response.status).toBe(route === "message" ? 200 : 202)
                  const body = route === "message" ? yield* Effect.promise(() => response.json()) : undefined
                  for (let i = 0; i < 150; i++) {
                    if (
                      installed &&
                      (yield* SessionStatus.Service.use((status) => status.get(session.id))).type === "idle"
                    )
                      break
                    yield* Effect.sleep("20 millis")
                  }
                  expect(installed).toBe(true)
                  const firstHistory = yield* sessions.messages({ sessionID: session.id })
                  const first = firstHistory.find((message) => message.info.id === before?.info.id)
                  expect(first).toEqual(before)
                  expect(
                    first?.parts.some(
                      (part) => part.type === "text" && part.text === "first answer remains successful",
                    ),
                  ).toBe(true)
                  expect(first?.info.role === "assistant" ? first.info.error : undefined).toBeUndefined()
                  if (body) expect(body).toEqual(first)
                  expect(errors).toHaveLength(0)
                  expect(yield* SessionPrefixSnapshot.get(session.id, key)).toBeUndefined()
                  expect(yield* SessionStatus.Service.use((status) => status.get(session.id))).toEqual({ type: "idle" })
                  Database.use((db) => db.run(sql`DROP TRIGGER reject_answer_watermark`))
                  const next = yield* Effect.promise(() => send("message", "continue with another question"))
                  expect(next.status).toBe(200)
                  const nextBody = yield* Effect.promise(() => next.json())
                  expect(nextBody.info.error).toBeUndefined()
                  expect(
                    nextBody.parts.some((part: { text?: string }) => part.text === "next answer rebuilt the prefix"),
                  ).toBe(true)
                  expect(
                    (yield* sessions.messages({ sessionID: session.id })).find(
                      (message) => message.info.id === before?.info.id,
                    ),
                  ).toEqual(before)
                  expect(yield* SessionPrefixSnapshot.get(session.id, key)).toMatchObject({
                    watermark_message_id: nextBody.info.id,
                  })
                  expect(stub.captures).toHaveLength(2)
                } finally {
                  off()
                  Database.use((db) => db.run(sql`DROP TRIGGER IF EXISTS reject_answer_watermark`))
                }
              }),
            ),
        })
      } finally {
        await stub.stop()
      }
    }, 30000)
  }
})
