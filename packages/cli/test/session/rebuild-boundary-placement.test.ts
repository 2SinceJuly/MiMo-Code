import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Command } from "../../src/command"
import type { Config } from "../../src/config"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { RECALL_REMINDER_MARKER, SessionPrompt } from "../../src/session/prompt"
import type { SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallsResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const FILES = ["alpha.txt", "beta.txt"]
const fileBody = (name: string) => Array.from({ length: 300 }, (_, i) => `${name} body line ${i}`).join("\n")

function config(origin: string, extra: Partial<Config.Info> = {}): Partial<Config.Info> {
  return {
    ...extra,
    enabled_providers: ["test"],
    model: "test/model",
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "test-key", baseURL: `${origin}/v1` },
        models: {
          model: {
            name: "Test",
            tool_call: true,
            limit: { context: 400_000, output: 10_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agent: { build: { model: "test/model" } },
    permission: { read: "allow" },
    lsp: false,
    formatter: false,
  }
}

type Captured = { role: string; content: unknown }

function text(message: Captured) {
  if (typeof message.content === "string") return message.content
  return (message.content as { type: string; text?: string }[]).map((part) => part.text ?? JSON.stringify(part)).join("\n")
}

function conversation(messages: Captured[]) {
  return messages.filter((message) => message.role !== "system")
}

describe("rebuild boundary placement", () => {
  test(
    "the boundary sorts after the tail, the next request carries the tail only through the boundary, and later messages stay live",
    async () => {
      const server = startScriptedLLMServer([
        { lines: textStopResponse("starting") },
        {
          lines: toolCallsResponse(
            FILES.map((file, index) => ({ id: `call-${index}`, name: "read", args: JSON.stringify({ file_path: file }) })),
          ),
        },
        { lines: textStopResponse("checks passed") },
        { lines: textStopResponse("live reply") },
        { lines: textStopResponse("second live reply") },
      ])
      try {
        await using tmp = await tmpdir({ git: true, config: config(server.origin) })
        for (const file of FILES) await Bun.write(path.join(tmp.path, file), fileBody(file))
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "rebuild placement" })
                const say = (value: string) =>
                  prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: value }] })

                yield* say("start the task")
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                expect(watermark.info.role).toBe("assistant")
                yield* seedCheckpoint(session.id, watermark.info.id)

                yield* say("run the checks on alpha and beta")
                const tail = (yield* sessions.messages({ sessionID: session.id })).filter(
                  (message) => message.info.id > watermark.info.id,
                )
                expect(tail.map((message) => message.info.role)).toEqual(["user", "assistant", "assistant"])
                const reminded = (message: (typeof tail)[number]) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.synthetic && part.text.includes(RECALL_REMINDER_MARKER),
                  )
                expect(reminded(tail[0]!)).toBe(true)

                yield* prompt.command({
                  sessionID: session.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })
                const stored = yield* sessions.messages({ sessionID: session.id })
                const boundary = stored.find((message) => message.parts.some((part) => part.type === "checkpoint"))!
                expect(stored.at(-1)!.info.id).toBe(boundary.info.id)
                for (const message of tail) expect(boundary.info.time.created).toBeGreaterThan(message.info.time.created)
                const marker = boundary.parts.find((part) => part.type === "checkpoint")!
                if (marker.type !== "checkpoint") throw new Error("expected a checkpoint part")
                expect(marker.coveredUpTo).toBe(watermark.info.id)
                expect(marker.digestUpTo).toBe(tail.at(-1)!.info.id)

                yield* say("after rebuild")
                const first = conversation(server.captures.at(-1)!.messages)
                expect(first.map((message) => message.role)).toEqual(["user", "user"])
                const digest = text(first[0]!)
                expect(digest).toContain("Summary of previous conversation from checkpoint files:")
                expect(digest).toContain("Recent user input (verbatim)")
                expect(digest).toContain("run the checks on alpha and beta")
                expect(digest).toContain("# Recent activity")
                for (const file of FILES) expect(digest).toContain(`read(file_path="${file}")`)
                expect(digest).toContain("- assistant: checks passed")
                for (const file of FILES) expect(JSON.stringify(first)).not.toContain(`${file} body line 0`)
                const live = text(first[1]!)
                expect(live).toContain("after rebuild")
                expect(live).not.toContain("run the checks on alpha and beta")
                // The recall reminder persisted on the tail user message is attached again to the newest user message.
                expect(live).toContain(RECALL_REMINDER_MARKER)

                yield* say("next step")
                const second = conversation(server.captures.at(-1)!.messages)
                expect(second.map((message) => message.role)).toEqual(["user", "user", "assistant", "user"])
                expect(text(second[0]!)).toBe(text(first[0]!))
                expect(text(second[1]!)).toContain("after rebuild")
                expect(text(second[2]!)).toContain("live reply")
                expect(text(second[3]!)).toContain("next step")
              }),
            ),
        })
      } finally {
        await server.stop()
      }
    },
    60_000,
  )

  test(
    "an automatic rebuild after a tool step digests that step, keeps the turn on its user message, and ends after the final step",
    async () => {
      const server = startScriptedLLMServer([
        { lines: textStopResponse("starting", { promptTokens: 1_000 }) },
        {
          lines: toolCallsResponse(
            FILES.map((file, index) => ({ id: `call-${index}`, name: "read", args: JSON.stringify({ file_path: file }) })),
            { promptTokens: 50_000 },
          ),
        },
        { lines: textStopResponse("checks passed", { promptTokens: 1_000 }) },
        { lines: textStopResponse("extra reply", { promptTokens: 1_000 }) },
      ])
      try {
        await using tmp = await tmpdir({
          git: true,
          config: config(server.origin, {
            compaction: { reserved: 100, max_context: 40_000 },
            checkpoint: { thresholds: [], reserved: 100 },
          }),
        })
        for (const file of FILES) await Bun.write(path.join(tmp.path, file), fileBody(file))
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "automatic rebuild after a tool step" })
                const say = (value: string) =>
                  prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: value }] })

                yield* say("start the task")
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                expect(watermark.info.role).toBe("assistant")
                yield* seedCheckpoint(session.id, watermark.info.id)

                yield* say("run the checks on alpha and beta")
                expect(server.captures).toHaveLength(3)

                const stored = yield* sessions.messages({ sessionID: session.id })
                const user = stored.find((message) => message.info.role === "user" && message.info.id > watermark.info.id)!
                const step = stored.find((message) => message.parts.some((part) => part.type === "tool"))!
                const boundary = stored.find((message) => message.parts.some((part) => part.type === "checkpoint"))!
                const reply = stored.at(-1)!
                expect(stored.map((message) => message.info.id).slice(-4)).toEqual([
                  user.info.id,
                  step.info.id,
                  boundary.info.id,
                  reply.info.id,
                ])
                const marker = boundary.parts.find((part) => part.type === "checkpoint")!
                if (marker.type !== "checkpoint") throw new Error("expected a checkpoint part")
                expect(marker.coveredUpTo).toBe(watermark.info.id)
                expect(marker.digestUpTo).toBe(step.info.id)
                if (reply.info.role !== "assistant") throw new Error("expected the final assistant reply")
                expect(reply.info.parentID).toBe(user.info.id)
                expect(reply.parts.some((part) => part.type === "text" && part.text === "checks passed")).toBe(true)

                const request = conversation(server.captures[2]!.messages)
                expect(request.map((message) => message.role)).toEqual(["user"])
                const digest = text(request[0]!)
                expect(digest).toContain("run the checks on alpha and beta")
                expect(digest).toContain("# Recent activity")
                for (const file of FILES) expect(digest).toContain(`read(file_path="${file}")`)
                expect(digest).toContain("mid-loop in an autonomous task")
                for (const file of FILES) expect(JSON.stringify(request)).not.toContain(`${file} body line 0`)
              }),
            ),
        })
      } finally {
        await server.stop()
      }
    },
    60_000,
  )
})

function seedCheckpoint(sessionID: SessionID, watermark: string) {
  return Effect.promise(async () => {
    await fs.mkdir(path.dirname(checkpointPath(sessionID)), { recursive: true })
    await Bun.write(checkpointPath(sessionID), "# Session checkpoint\n\n## §1 Active intent\nRun the checks.\n")
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({ last_checkpoint_message_id: watermark as never })
        .where(eq(SessionTable.id, sessionID))
        .run(),
    )
  })
}
