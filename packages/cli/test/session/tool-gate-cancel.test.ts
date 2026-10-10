import { expect, spyOn } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Question } from "../../src/question"
import { MessageV2 } from "../../src/session/message-v2"
import { ToolGate } from "../../src/tool/gate"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, textStopResponse, toolCallsResponse } from "../lib/scripted-llm-server"

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    Question.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

it.live(
  "a cancelled write queued behind a question in the same step never executes [TP-SR-R21-25]",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        {
          lines: toolCallsResponse([
            {
              id: "ask-user",
              name: "question",
              args: JSON.stringify({ questions: [{ question: "Continue?", header: "Continue", options: [] }] }),
            },
            {
              id: "call-write",
              name: "write",
              args: JSON.stringify({ file_path: "cancelled.txt", content: "after stop" }),
            },
          ]),
        },
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Cancellation" })
            const bus = yield* Bus.Service
            const questions = yield* Question.Service
            // Observe actual release without replacing the gate implementation.
            const leaving = spyOn(ToolGate.prototype, "leave")
            const entering = spyOn(ToolGate.prototype, "run")
            yield* Effect.addFinalizer(() => Effect.sync(() => leaving.mockRestore()))
            yield* Effect.addFinalizer(() => Effect.sync(() => entering.mockRestore()))
            const asked = yield* Deferred.make<void>()
            const queued = yield* Deferred.make<void>()
            const rejected: Question.Request["id"][] = []
            const unsubscribeRejected = yield* bus.subscribeCallback(Question.Event.Rejected, (event) => {
              if (event.properties.sessionID === session.id) rejected.push(event.properties.requestID)
            })
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribeRejected))
            const unsubscribeAsked = yield* bus.subscribeCallback(Question.Event.Asked, (event) => {
              if (event.properties.sessionID === session.id) Deferred.doneUnsafe(asked, Effect.void)
            })
            const unsubscribeQueued = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
              const part = event.properties.part
              if (
                part.sessionID === session.id &&
                part.type === "tool" &&
                part.callID === "call-write" &&
                part.state.status === "running"
              ) {
                Deferred.doneUnsafe(queued, Effect.void)
              }
            })
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribeAsked))
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribeQueued))
            yield* Effect.addFinalizer(() =>
              questions
                .list()
                .pipe(
                  Effect.flatMap((pending) =>
                    Effect.forEach(pending, (question) => questions.reject(question.id), { discard: true }),
                  ),
                ),
            )
            yield* Effect.addFinalizer(() => prompt.cancel(session.id))
            const running = yield* prompt
              .prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                parts: [{ type: "text", text: "Write the file" }],
              })
              .pipe(Effect.forkChild)
            yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
            yield* Deferred.await(queued).pipe(Effect.timeout("10 seconds"))
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "cancelled.txt")).exists())).toBe(false)
            yield* prompt.cancel(session.id)
            const result = yield* Fiber.join(running)
            expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageAbortedError")
            expect(
              entering.mock.calls.find(([tool, callID]) => tool === "question" && callID === "ask-user")?.[3]?.signal
                ?.aborted,
            ).toBe(true)
            const pendingAfterStop = yield* questions.list()
            const toolsAfterStop = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(toolsAfterStop).toHaveLength(2)
            expect(toolsAfterStop.every((part) => part.state.status === "error")).toBe(true)
            expect({ pending: pendingAfterStop, rejected }).toEqual({ pending: [], rejected: [expect.any(String)] })
            yield* Effect.promise(async () => {
              while (true) {
                const index = leaving.mock.calls.findIndex(([token]) => token.startsWith("ask-user#"))
                const gate = leaving.mock.contexts[index]
                if (gate instanceof ToolGate && gate.runningCount === 0 && gate.queuedCount === 0) return
                await Bun.sleep(10)
              }
            }).pipe(Effect.timeout("1 second"))
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "cancelled.txt")).exists())).toBe(false)
            const tools = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(tools).toHaveLength(2)
            expect(tools.every((part) => part.state.status === "error")).toBe(true)
          }),
        {
          git: true,
          config: {
            enabled_providers: ["test"],
            model: "test/model",
            provider: {
              test: {
                npm: "@ai-sdk/openai-compatible",
                env: [],
                options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
                models: {
                  model: {
                    name: "Test",
                    tool_call: true,
                    limit: { context: 32000, output: 2000 },
                    modalities: { input: ["text"], output: ["text"] },
                  },
                },
              },
            },
            agent: { build: { model: "test/model" } },
            permission: { edit: "allow", question: "allow" },
            lsp: false,
            formatter: false,
          },
        },
      )
    }),
  20000,
)

// [TP-SR-R21-28] [TP-SR-R21-30]
for (const boundary of ["partial", "complete-empty"] as const) {
  it.live(
    `Stop preserves the actual tool input boundary (${boundary})`,
    () =>
      Effect.gen(function* () {
        const callID = "interrupted-input"
        const tool = boundary === "partial" ? "bash" : "plan_exit"
        const lines = toolCallsResponse([
          { id: callID, name: tool, args: boundary === "partial" ? '{"command":' : "{}" },
        ])
        const stream =
          boundary === "partial"
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  for (const line of lines.slice(0, -2)) controller.enqueue(new TextEncoder().encode(line))
                },
              })
            : undefined
        const server = startScriptedLLMServer([
          { lines, stream },
          { lines: textStopResponse("continued from a complete tool invocation") },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const bus = yield* Bus.Service
              const questions = yield* Question.Service
              const session = yield* sessions.create({ title: "Interrupted input provenance" })
              const reached = yield* Deferred.make<void>()
              const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
                const part = event.properties.part
                if (
                  part.sessionID === session.id &&
                  part.type === "tool" &&
                  part.callID === callID &&
                  part.state.status === (boundary === "partial" ? "pending" : "running")
                )
                  Deferred.doneUnsafe(reached, Effect.void)
              })
              yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
              yield* Effect.addFinalizer(() => prompt.cancel(session.id))
              const running = yield* prompt
                .prompt({
                  sessionID: session.id,
                  agent: boundary === "partial" ? "build" : "plan",
                  harness: "default",
                  parts: [{ type: "text", text: "Use the requested tool." }],
                })
                .pipe(Effect.forkChild)
              yield* Deferred.await(reached).pipe(Effect.timeout("10 seconds"))
              if (boundary === "complete-empty") {
                while ((yield* questions.list()).length === 0) yield* Effect.sleep("10 millis")
              }
              const beforeStop = yield* sessions.messages({ sessionID: session.id })
              const beforeTool = beforeStop
                .flatMap((message) => message.parts)
                .find((part) => part.type === "tool" && part.callID === callID)
              expect(beforeTool?.type).toBe("tool")
              if (beforeTool?.type !== "tool") throw new Error("missing streamed tool")
              expect(beforeTool.state.status).toBe(boundary === "partial" ? "pending" : "running")
              expect(beforeTool.state.input).toEqual({})
              yield* prompt.cancel(session.id)
              yield* Fiber.join(running)
              const stopped = yield* sessions.messages({ sessionID: session.id })
              const carrier = stopped.find((message) =>
                message.parts.some((part) => part.type === "tool" && part.callID === callID),
              )!
              const stoppedTool = carrier.parts.find((part) => part.type === "tool" && part.callID === callID)!
              expect(stoppedTool.type === "tool" && stoppedTool.state.status).toBe("error")
              const deleted: string[] = []
              const off = yield* bus.subscribeCallback(MessageV2.Event.Removed, (event) => {
                if (event.properties.sessionID === session.id) deleted.push(event.properties.messageID)
              })
              yield* Effect.addFinalizer(() => Effect.sync(off))
              const resumed = yield* prompt
                .resume({ sessionID: session.id, assistantMessageID: carrier.info.id })
                .pipe(Effect.exit)
              expect(resumed._tag).toBe(boundary === "partial" ? "Failure" : "Success")
              expect(stoppedTool).toMatchObject({
                state: { status: "error", input: {}, inputComplete: boundary === "complete-empty" },
              })
              const after = yield* sessions.messages({ sessionID: session.id })
              if (boundary === "partial") {
                expect(server.captures).toHaveLength(1)
                expect(after).toEqual(stopped)
                expect(deleted).toEqual([])
              } else {
                expect(server.captures).toHaveLength(2)
                expect(server.captures[1].messages.at(-1)?.role).toBe("tool")
                expect(after.find((message) => message.info.id === carrier.info.id)?.parts).toEqual(carrier.parts)
                expect(
                  after.filter((message) => message.info.role === "user").map((message) => message.info.id),
                ).toEqual(stopped.filter((message) => message.info.role === "user").map((message) => message.info.id))
              }
            }),
          {
            git: true,
            config: {
              enabled_providers: ["test"],
              model: "test/model",
              provider: {
                test: {
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
                  models: {
                    model: {
                      name: "Test",
                      tool_call: true,
                      limit: { context: 32000, output: 2000 },
                      modalities: { input: ["text"], output: ["text"] },
                    },
                  },
                },
              },
              agent: { build: { model: "test/model" }, plan: { model: "test/model" } },
              permission: { question: "allow" },
              lsp: false,
              formatter: false,
            },
          },
        )
      }),
    30000,
  )
}
