/**
 * Integration tests for T01: a `finish=stop` step with no usable output
 * (think-only = reasoning only, or empty = nothing at all) must not silently
 * break into an empty assistant. process() drops the empty turn and raises
 * InvalidOutputError so SessionRetry.policy (decide → retryable unknown) owns
 * the retry budget; on exhaustion the terminal InvalidOutputError is written.
 * No reminder message is injected.
 *
 * Driven through a real Session.prompt(...) against the scripted HTTP LLM stub.
 */

import path from "path"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { SessionPrefixSnapshot } from "../../src/session/prefix-snapshot"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import {
  startScriptedLLMServer,
  textStopResponse,
  emptyStopResponse,
  reasoningLengthResponse,
  reasoningStopResponse,
} from "../lib/scripted-llm-server"

void Log.init({ print: false })

function assistantOnly(
  msgs: MessageV2.WithParts[],
): (MessageV2.WithParts & { info: MessageV2.Assistant })[] {
  return msgs.filter((m): m is MessageV2.WithParts & { info: MessageV2.Assistant } => m.info.role === "assistant")
}

// The retry must resend the first attempt's history unchanged: no injected reminder.
function nonSystemMessages(capture: { messages: unknown }) {
  return (capture.messages as { role: string; content: unknown }[]).filter((m) => m.role !== "system")
}

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

function writeConfig(dir: string, origin: string) {
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: {
        alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } },
      },
      agent: {
        build: { model: "alibaba/qwen-plus" },
        "checkpoint-writer": { model: "alibaba/qwen-plus" },
      },
      // Empty/think-only output is retried via SessionRetry.policy (unknown budget).
      retry: {
        unknown: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, deadlineMs: 2000 },
      },
    }),
  )
}

function writeGPTConfig(dir: string, origin: string) {
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["test"],
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "gpt-5.5": {
              id: "gpt-5.5",
              name: "GPT-5.5",
              attachment: false,
              reasoning: true,
              temperature: false,
              tool_call: true,
              release_date: "2026-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL: `${origin}/v1` },
        },
      },
      agent: { build: { model: "test/gpt-5.5" } },
    }),
  )
}

describe("invalid-output continuation — integration", () => {
  // [TP-SR-R21-07]
  test("empty stop is dropped and retried inside process; cancel after settle is clean", async () => {
    await using tmp = await tmpdir({ git: true })
    // First sample is empty (dropped + retried inside process via SessionRetry);
    // second sample is the recovered answer. advance() hangs after the successful
    // step completes so cancel runs against a durable finished turn.
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }, { lines: textStopResponse("recovered answer") }])
    const entered = Promise.withResolvers<void>()
    const advance = spyOn(SessionPrefixSnapshot, "advance").mockImplementation(() =>
      Effect.sync(entered.resolve).pipe(Effect.andThen(Effect.never)),
    )
    try {
      await writeConfig(tmp.path, stub.origin)
      const result = await Instance.provide({
        directory: tmp.path,
        fn: () => run(Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({ title: "empty-stop-cancel-window" })
          const fiber = yield* prompt.prompt({
            sessionID: session.id, agent: "build", parts: [{ type: "text", text: "Answer my question." }],
          }).pipe(Effect.exit, Effect.forkChild)
          yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("10 seconds"))
          expect(advance).toHaveBeenCalledTimes(1)
          const atBarrier = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
          yield* prompt.cancel(session.id)
          yield* Fiber.join(fiber)
          advance.mockRestore()
          const afterCancel = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
          return { atBarrier, afterCancel, providerCalls: stub.captures.length }
        })),
      })
      expect(result.afterCancel).toEqual(result.atBarrier)
      const assistants = assistantOnly(result.afterCancel)
      expect(assistants.length).toBe(1)
      const assistant = assistants[0]!
      expect(assistant.info.finish).toBe("stop")
      expect(assistant.info.time.completed).toBeDefined()
      expect(assistant.info.error).toBeUndefined()
      // Empty attempt was dropped inside process; only the recovered turn remains.
      expect(assistant.parts.some((part) => part.type === "text" && part.text === "recovered answer")).toBe(true)
      expect(result.providerCalls).toBe(2)
    } finally {
      advance.mockRestore()
      await Instance.disposeAll()
      await stub.stop()
    }
  }, 30_000)

  test("empty stop step is deleted and retried, second call produces a non-empty final assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }, { lines: textStopResponse("final answer") }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-empty" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              // First empty stop => delete + retry; second call => final text.
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const assistants = assistantOnly(msgs)
              expect(assistants.length).toBe(1)
              expect(assistants[0]?.info.id).toBe(result.info.id)
              const retry = stub.captures[1].messages as { role: string; content: unknown }[]
              const nonSystem = retry.filter((m) => m.role !== "system")
              expect(nonSystem.length).toBe(1)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("no usable"))).toBe(false)
              expect(nonSystem).toEqual(nonSystemMessages(stub.captures[0]))
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("think-only (reasoning only) stop step is deleted and retried, second call produces a final assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("let me think about this...") },
      { lines: textStopResponse("final answer") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-think-only" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const assistants = assistantOnly(msgs)
              expect(assistants.length).toBe(1)
              expect(assistants.some((m) => m.parts.some((p) => p.type === "reasoning"))).toBe(false)
              const retry = stub.captures[1].messages as { role: string; content: unknown }[]
              const nonSystem = retry.filter((m) => m.role !== "system")
              expect(nonSystem.length).toBe(1)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("no usable"))).toBe(false)
              expect(nonSystem).toEqual(nonSystemMessages(stub.captures[0]))
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("ordinary actor retry deletes the empty turn and injects no reminder", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }, { lines: textStopResponse("actor result") }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-actor" })
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                agentID: "general-1",
                parts: [{ type: "text", text: "Do delegated work." }],
              })
              const retry = stub.captures[1].messages as { role: string; content: unknown }[]
              const nonSystem = retry.filter((m) => m.role !== "system")
              expect(nonSystem.length).toBe(1)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("no usable"))).toBe(false)
              expect(nonSystem).toEqual(nonSystemMessages(stub.captures[0]))
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "general-1" })
              const assistants = assistantOnly(msgs)
              expect(assistants.length).toBe(1)
              expect(assistants.some((m) => m.info.error)).toBe(false)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("checkpoint-writer retry deletes the empty turn and converges on CHECKPOINT_COMPLETE", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      { lines: textStopResponse("CHECKPOINT_COMPLETE") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-checkpoint-writer" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "checkpoint-writer",
                parts: [{ type: "text", text: "Update the checkpoint." }],
              })
              const retry = stub.captures[1].messages as { role: string; content: unknown }[]
              const nonSystem = retry.filter((m) => m.role !== "system")
              expect(nonSystem.length).toBe(1)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("checkpoint writer turn ended"))).toBe(false)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("CHECKPOINT_COMPLETE"))).toBe(false)
              expect(nonSystem).toEqual(nonSystemMessages(stub.captures[0]))
              expect(result.parts.some((part) => part.type === "text" && part.text === "CHECKPOINT_COMPLETE")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("retry exhaustion writes a terminal InvalidOutputError", async () => {
    await using tmp = await tmpdir({ git: true })
    // writeConfig sets retry.unknown.maxRetries=1: initial attempt + 1 retry,
    // then the empty stop is terminal under SessionRetry.policy.
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }, { lines: emptyStopResponse() }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-exhaust" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error?.name).toBe("InvalidOutputError")
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const assistants = assistantOnly(msgs)
              // Empty attempts were dropped; only the terminal assistant remains.
              expect(assistants.length).toBe(1)
              expect(assistants[0]?.info.error?.name).toBe("InvalidOutputError")
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  // [TP-SR-R21-07]
  test("GPT reasoning-only stop step is terminal and is not retried", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("let me think about this...") },
      { lines: textStopResponse("unexpected retry") },
    ])
    try {
      await writeGPTConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "gpt-reasoning-only" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "reasoning" && p.text.includes("let me think"))).toBe(true)
              expect(result.parts.some((p) => p.type === "text")).toBe(false)
              expect(yield* prompt.recovery({ sessionID: session.id, agentID: "main" })).toEqual([])
              const resumed = yield* Effect.promise(() => Promise.resolve(Server.Default().app.request(
                `/session/${session.id}/resume?directory=${encodeURIComponent(tmp.path)}`,
                { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
              )))
              expect(resumed.status).toBe(404)
              expect(stub.captures.length).toBe(1)
              expect((yield* sessions.messages({ sessionID: session.id, agentID: "main" })).find((message) => message.info.id === result.info.id)).toEqual(result)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("GPT reasoning-only length step still auto-continues", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningLengthResponse("token budget exhausted while thinking...") },
      { lines: textStopResponse("final answer") },
    ])
    try {
      await writeGPTConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "gpt-reasoning-length" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(2)
              expect(JSON.stringify(stub.captures[1].messages)).toContain("output token limit")
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})
