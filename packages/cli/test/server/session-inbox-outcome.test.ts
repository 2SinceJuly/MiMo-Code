import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { MessageID, type SessionID } from "../../src/session/schema"
import { MessageTable } from "../../src/session/session.sql"
import { InboxTable, inboxControllerRef } from "../../src/inbox"
import { Database, eq, sql } from "../../src/storage"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })
afterEach(async () => { mock.restore(); await Instance.disposeAll() })
const model = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }
const config = (origin: string) => ({ enabled_providers: ["alibaba"],
  provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } } },
  agent: { build: { model: "alibaba/qwen-plus" } }, checkpoint: { thresholds: [] } })
function request(directory: string, sessionID: string, route: string, body: unknown) {
  return Promise.resolve(Server.Default().app.request(`/session/${sessionID}/${route}?directory=${encodeURIComponent(directory)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }))
}
const receipts = (sessionID: SessionID) => Database.use(db => db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, sessionID)).all())

// The Inbox is the durable queue; Runner only owns one execution lease.
// [TP-RUN-R1C-08] B/C keep individual receipts while the selected current parent owns one failure.
describe("Inbox execution outcome ownership", () => {
  for (const boundary of ["ordinary", "reused-prelude", "reused-language"] as const) test(`claimed initialization failure preserves its actual owner (${boundary})`, async () => {
    const reused = boundary !== "ordinary"
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: textStopResponse("A successful answer") },
      { lines: textStopResponse("next independent answer") },
    ])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const plugin = yield* Plugin.Service
        const provider = yield* Provider.Service
        const session = yield* sessions.create({ title: "Inbox ownership after A" })
        const bID = MessageID.ascending()
        const send = (id: MessageID, text: string, noReply = false) => ({ sessionID: session.id, messageID: id, noReply,
          agent: "build", model, parts: [{ type: "text" as const, text }] })
        if (reused) yield* prompt.prompt(send(bID, "historical B", true))
        const originalCreated = reused ? Database.use(db => db.select({ created: MessageTable.time_created }).from(MessageTable).where(eq(MessageTable.id, bID)).get())!.created : undefined
        const aID = MessageID.ascending(), cID = MessageID.ascending()
        const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
        const trigger = plugin.trigger
        let held = false
        const post = spyOn(plugin, "trigger").mockImplementation((...args) => {
          if (args[0] === "session.pre" && held && boundary === "reused-prelude") return Effect.die(new Error("claimed initialization failed"))
          if (args[0] !== "session.post" || held) return trigger(...args)
          held = true
          return Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Effect.promise(() => release.promise)), Effect.andThen(trigger(...args)))
        })
        const a = request(tmp.path, session.id, "message", send(aID, "A current question"))
        const aResponse = yield* Effect.promise(() => a)
        const aBody = aResponse.json()
        yield* Effect.promise(() => entered.promise)
        const accept = (input: ReturnType<typeof send>) => Effect.promise(() => request(tmp.path, session.id, "prompt_async", input))
        // Actual persisted order wins even when an older identity is accepted last.
        const c = reused ? yield* accept(send(cID, "C newest question")) : undefined
        const b = yield* accept(send(bID, "B additional question"))
        const last = c ?? (yield* accept(send(cID, "C newest question")))
        expect(b.status).toBe(202); expect(last.status).toBe(202)
        const bReceipt = yield* Effect.promise(() => b.json())
        const cReceipt = yield* Effect.promise(() => last.json())
        expect(bReceipt.receiptId).not.toBe(cReceipt.receiptId)
        if (reused) expect(Database.use(db => db.select({ created: MessageTable.time_created }).from(MessageTable).where(eq(MessageTable.id, bID)).get())!.created).toBe(originalCreated!)
        const before = yield* sessions.messages({ sessionID: session.id })
        expect(before.filter(m => m.info.role === "user").map(m => m.info.id)).toEqual(reused ? [bID, aID, cID] : [aID, bID, cID])
        const language = boundary === "reused-prelude" ? undefined : spyOn(provider, "getLanguage").mockImplementation(() => Effect.die(new Error("claimed initialization failed")))
        release.resolve()
        const first = yield* Effect.promise(() => aBody)
        for (let i = 0; i < 300 && receipts(session.id).some(r => r.state === "accepted" || r.state === "claimed"); i++) yield* Effect.sleep("10 millis")
        post.mockRestore(); language?.mockRestore()
        expect(first.info.error).toBeUndefined()
        const rows = receipts(session.id)
        for (const id of [bReceipt.receiptId, cReceipt.receiptId]) {
          expect(rows.find(r => r.id === id)).toMatchObject({ state: "cancelled", outcome: "never_ran", consumed: false, delivery_message_id: null })
        }
        const history = yield* sessions.messages({ sessionID: session.id })
        expect(history.filter(m => m.info.role === "assistant" && m.info.error)).toHaveLength(1)
        const failure = history.find(m => m.info.role === "assistant" && m.info.error)!
        expect(failure.info).toMatchObject({ parentID: boundary === "reused-language" ? bID : cID, error: { data: { message: "claimed initialization failed" } } })
        // Late result registration must return that actual durable failure,
        // even if its assistant was created before any delivery was recorded.
        for (const id of [bID, cID]) {
          const late = yield* prompt.prompt(send(id, id === bID ? "B additional question" : "C newest question")).pipe(Effect.timeout("5 seconds"))
          expect(late).toEqual(failure)
        }
        expect(receipts(session.id)).toEqual(rows)
        expect(history.find(m => m.info.id === first.info.id)).toEqual(first)
        expect(yield* SessionStatus.Service.use(s => s.get(session.id))).toEqual({ type: "idle" })
        expect(stub.captures).toHaveLength(1)
        const next = yield* prompt.prompt(send(MessageID.ascending(), "next independent input"))
        expect(next.info.role === "assistant" && next.info.error).toBeUndefined()
        expect(next.parts.some(p => p.type === "text" && p.text === "next independent answer")).toBe(true)
        expect(stub.captures).toHaveLength(2)
      })) })
    } finally { await stub.stop() }
  }, 30_000)

  // [TP-RUN-R1C-05][TP-RUN-R1C-07][TP-RUN-R1C-08] Real provider denial is consumed,
  // delivered once, and terminal, whether the current owner reads B/C before its next step.
  for (const result of ["success", "quota"] as const) test(`B/C delivery produces one ${result} result and no extra wake request`, async () => {
    await using tmp = await tmpdir({ git: true })
    const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const stub = startScriptedLLMServer([
      { lines: textStopResponse("A first answer"), beforeReply: async () => { entered.resolve(); await release.promise } },
      result === "quota" ? { status: 403, lines: [JSON.stringify({ error: { message: "quota used up", type: "usage_not_included" } })] }
        : { lines: textStopResponse("B and C result") },
      { lines: textStopResponse("D subsequent answer") },
    ])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "Consumed inbox result" })
        const send = (id: MessageID, text: string) => ({ messageID: id, agent: "build", model, parts: [{ type: "text" as const, text }] })
        const a = yield* Effect.promise(() => request(tmp.path, session.id, "message", send(MessageID.ascending(), "A question")))
        const aBody = a.json()
        yield* Effect.promise(() => entered.promise)
        const bID = MessageID.ascending(), cID = MessageID.ascending()
        const b = yield* Effect.promise(() => request(tmp.path, session.id, "message", send(bID, "B added instruction")))
        const c = yield* Effect.promise(() => request(tmp.path, session.id, "prompt_async", send(cID, "C latest instruction")))
        expect(b.status).toBe(202); expect(c.status).toBe(202)
        const bReceipt = yield* Effect.promise(() => b.json()), cReceipt = yield* Effect.promise(() => c.json())
        release.resolve()
        yield* Effect.promise(() => aBody)
        for (let i = 0; i < 300 && receipts(session.id).some(r => r.state === "accepted" || r.state === "claimed"); i++) yield* Effect.sleep("10 millis")
        const rows = receipts(session.id)
        const bRow = rows.find(r => r.id === bReceipt.receiptId)!, cRow = rows.find(r => r.id === cReceipt.receiptId)!
        for (const row of [bRow, cRow]) expect(row).toMatchObject({ state: "settled", consumed: true, outcome: result === "quota" ? "assistant_error" : "success" })
        expect(bRow.delivery_message_id).toBe(cRow.delivery_message_id)
        expect(bRow.delivery_message_id).toEqual(expect.any(String))
        const history = yield* sessions.messages({ sessionID: session.id })
        const assistants = history.filter(m => m.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        const answer = assistants.find(m => m.info.id === cRow.delivery_message_id)!
        expect(answer.info).toMatchObject({ parentID: cID })
        if (result === "quota") expect(answer.info).toMatchObject({ error: { name: "APIError", data: { statusCode: 403 } } })
        else expect(answer.parts.some(p => p.type === "text" && p.text === "B and C result")).toBe(true)
        expect(stub.captures).toHaveLength(2)
        expect(JSON.stringify(stub.captures[1].messages)).toContain("B added instruction")
        expect(JSON.stringify(stub.captures[1].messages)).toContain("C latest instruction")
        expect(yield* SessionStatus.Service.use(s => s.get(session.id))).toEqual({ type: "idle" })
        const next = yield* prompt.prompt({ sessionID: session.id, ...send(MessageID.ascending(), "D next input") })
        expect(next.info.role === "assistant" && next.info.error).toBeUndefined()
        expect(next.parts.some(p => p.type === "text" && p.text === "D subsequent answer")).toBe(true)
        expect(stub.captures).toHaveLength(3)
      })) })
    } finally { release.resolve(); await stub.stop() }
  }, 30_000)

  // [TP-RUN-R1C-09] Inbox.accept is atomic: part failure rolls back a new user and its receipt.
  test("failed queued part transaction leaves no user, receipt or error result", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "atomic inbox input" })
      Database.use(db => db.run(sql`CREATE TEMP TRIGGER reject_atomic_part BEFORE INSERT ON part BEGIN SELECT RAISE(FAIL, 'atomic part write failed'); END`))
      try {
        const response = yield* Effect.promise(() => request(tmp.path, session.id, "prompt_async", { messageID: MessageID.ascending(),
          agent: "build", model, parts: [{ type: "text", text: "must not partially save" }] }))
        expect(response.status).toBe(500)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ name: "UnknownError", data: { message: expect.stringContaining("atomic part write failed") } })
        expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(0)
        expect(receipts(session.id)).toHaveLength(0)
        expect(yield* SessionStatus.Service.use(s => s.get(session.id))).toEqual({ type: "idle" })
      } finally { Database.use(db => db.run(sql`DROP TRIGGER reject_atomic_part`)) }
    })) })
  })

  // [TP-RUN-R1C-07][TP-RUN-R1C-09] A post-commit accept defect owns only its
  // newly accepted receipt and cannot invent delivery or another model step.
  test("post-commit acceptance failure is durable and remains never_ran", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
      const sessions = yield* Session.Service
      yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "post-commit admission" })
      const controller = inboxControllerRef.current!
      const id = MessageID.ascending()
      inboxControllerRef.current = { ...controller, accept: (...args) => controller.accept(...args).pipe(
        Effect.andThen(Effect.die(new Error("accept event publication failed"))),
      ) }
      try {
        const response = yield* Effect.promise(() => request(tmp.path, session.id, "prompt_async", {
          messageID: id, agent: "build", model, parts: [{ type: "text", text: "committed input" }],
        }))
        expect(response.status).toBe(202)
        const body = yield* Effect.promise(() => response.json())
        expect(receipts(session.id)).toMatchObject([{ id: body.receiptId, input_message_id: id,
          state: "cancelled", outcome: "never_ran", consumed: false, delivery_message_id: null }])
        const history = yield* sessions.messages({ sessionID: session.id })
        expect(history.filter(m => m.info.role === "user")).toHaveLength(1)
        expect(history.filter(m => m.info.role === "assistant")).toMatchObject([{ info: { parentID: id,
          error: { data: { message: "accept event publication failed" } } } }])
        expect(yield* SessionStatus.Service.use(s => s.get(session.id))).toEqual({ type: "idle" })
      } finally { inboxControllerRef.current = controller }
    })) })
  })

  // [TP-RUN-R1C-07][TP-RUN-R1C-09] Two failed accepts of the same newly
  // committed ID share one receipt and cannot both acquire error settlement.
  test("concurrent same-ID post-commit failures produce one terminal error receipt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
      const sessions = yield* Session.Service
      yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "concurrent failed accept" })
      const controller = inboxControllerRef.current!
      const both = Promise.withResolvers<void>()
      let count = 0
      inboxControllerRef.current = { ...controller, accept: (...args) => controller.accept(...args).pipe(
        Effect.tap(() => Effect.sync(() => { if (++count === 2) both.resolve() })),
        Effect.andThen(Effect.promise(() => both.promise)),
        Effect.andThen(Effect.die(new Error("same-ID postcommit callback failed"))),
      ) }
      try {
        const id = MessageID.ascending()
        const input = { messageID: id, agent: "build", model, parts: [{ type: "text", text: "one logical input" }] }
        const responses = yield* Effect.promise(() => Promise.all([
          request(tmp.path, session.id, "prompt_async", input),
          request(tmp.path, session.id, "prompt_async", input),
        ]))
        // The first owner returns its durable receipt; a concurrent loser may
        // reject its own publication error, but must never create another error.
        expect(responses.some(r => r.status === 202)).toBe(true)
        for (const response of responses) expect([202, 500]).toContain(response.status)
        const bodies = yield* Effect.promise(() => Promise.all(responses.map(r => r.json())))
        const accepted = bodies[responses.findIndex(r => r.status === 202)]
        for (let i = 0; i < responses.length; i++) {
          if (responses[i].status === 202) expect(bodies[i].receiptId).toBe(accepted.receiptId)
          else expect(bodies[i]).toMatchObject({ name: "UnknownError", data: { message: "same-ID postcommit callback failed" } })
        }
        expect(receipts(session.id)).toMatchObject([{ id: accepted.receiptId, input_message_id: id,
          state: "cancelled", outcome: "never_ran", consumed: false, delivery_message_id: null }])
        const history = yield* sessions.messages({ sessionID: session.id })
        expect(history.filter(m => m.info.role === "user")).toHaveLength(1)
        expect(history.filter(m => m.info.role === "assistant")).toMatchObject([{ info: { parentID: id,
          error: { data: { message: "same-ID postcommit callback failed" } } } }])
        expect(yield* SessionStatus.Service.use(s => s.get(session.id))).toEqual({ type: "idle" })
      } finally { inboxControllerRef.current = controller; both.resolve() }
    })) })
  }, 30_000)

  // [TP-RUN-R1C-07][TP-RUN-R1C-08] An active loop can claim B while its accept
  // callback is still finishing. Once claimed, only that execution settles B.
  for (const racedCompletion of [false, true]) test(`post-commit acceptance failure after claim attaches to its owner (completion race=${racedCompletion})`, async () => {
    await using tmp = await tmpdir({ git: true })
    const first = Promise.withResolvers<void>(), releaseFirst = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>(), releaseSecond = Promise.withResolvers<void>()
    const stub = startScriptedLLMServer([
      { lines: toolCallResponse({ id: "call-inbox-owner", name: "todowrite", args: JSON.stringify({ todos: [] }) }),
        beforeReply: async () => { first.resolve(); await releaseFirst.promise } },
      { lines: textStopResponse("existing owner answered B"), beforeReply: async () => { second.resolve(); await releaseSecond.promise } },
    ])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "claimed post-commit handoff" })
        const a = yield* Effect.promise(() => request(tmp.path, session.id, "message", {
          messageID: MessageID.ascending(), agent: "build", model, parts: [{ type: "text", text: "A first tool step" }],
        }))
        const aBody = a.json()
        yield* Effect.promise(() => first.promise)
        const bID = MessageID.ascending()
        const controller = inboxControllerRef.current!
        inboxControllerRef.current = { ...controller,
          accept: (...args) => controller.accept(...args).pipe(
          Effect.tap(() => Effect.sync(() => releaseFirst.resolve())),
          Effect.andThen(Effect.promise(() => second.promise)),
          Effect.tap(() => racedCompletion ? Effect.sync(() => releaseSecond.resolve()).pipe(
            Effect.andThen(Effect.promise(() => aBody)),
            Effect.andThen(Effect.sync(() => expect(receipts(session.id).find(r => r.input_message_id === bID)?.state).toBe("settled"))),
          ) : Effect.void),
          Effect.andThen(Effect.die(new Error("late accept callback failed"))),
        ) }
        try {
          const input = { messageID: bID, agent: "build", model, parts: [{ type: "text" as const, text: "B accepted before next step" }] }
          const b = racedCompletion ? undefined : yield* Effect.promise(() => request(tmp.path, session.id, "prompt_async", input))
          const returned = racedCompletion ? yield* prompt.prompt({ sessionID: session.id, ...input }).pipe(Effect.timeout("5 seconds")) : undefined
          if (b) expect(b.status).toBe(202)
          const body = b ? yield* Effect.promise(() => b.json()) : { receiptId: receipts(session.id).find(r => r.input_message_id === bID)!.id }
          if (returned) {
            expect(returned.info).toMatchObject({ parentID: bID })
            expect(returned.parts.some(p => p.type === "text" && p.text === "existing owner answered B")).toBe(true)
          }
          expect(receipts(session.id).find(r => r.id === body.receiptId)).toMatchObject({ state: racedCompletion ? "settled" : "claimed", consumed: true })
          releaseSecond.resolve()
          yield* Effect.promise(() => aBody)
          for (let i = 0; i < 200 && receipts(session.id).some(r => r.state === "claimed"); i++) yield* Effect.sleep("10 millis")
          const row = receipts(session.id).find(r => r.id === body.receiptId)!
          expect(row).toMatchObject({ state: "settled", outcome: "success", consumed: true, error: null })
          const history = yield* sessions.messages({ sessionID: session.id })
          expect(history.filter(m => m.info.role === "assistant" && m.info.error)).toHaveLength(0)
          expect(history.filter(m => m.info.role === "assistant" && m.info.parentID === bID)).toHaveLength(1)
          expect(history.find(m => m.info.id === row.delivery_message_id)?.parts.some(p => p.type === "text" && p.text === "existing owner answered B")).toBe(true)
          expect(stub.captures).toHaveLength(2)
          expect(yield* SessionStatus.Service.use(s => s.get(session.id))).toEqual({ type: "idle" })
        } finally { inboxControllerRef.current = controller; releaseSecond.resolve() }
      })) })
    } finally { releaseFirst.resolve(); releaseSecond.resolve(); await stub.stop() }
  }, 30_000)


  // [TP-RUN-R1C-08] A was consumed at a tool step; B was consumed later in
  // the same run. Late result attachment must match the run's live final RB,
  // even after an independent C run has finished.
  test("late A receipt replays the final B result from its own run", async () => {
    await using tmp = await tmpdir({ git: true })
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const stub = startScriptedLLMServer([
      { lines: toolCallResponse({ id: "call-late-A", name: "todowrite", args: JSON.stringify({ todos: [] }) }),
        beforeReply: async () => { entered.resolve(); await release.promise } },
      { lines: textStopResponse("RB final shared outcome") },
      { lines: textStopResponse("RC independent outcome") },
    ])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "Late shared run replay" })
        const aID = MessageID.ascending(), bID = MessageID.ascending(), cID = MessageID.ascending()
        const input = (id: MessageID, text: string) => ({ messageID: id, agent: "build", model, parts: [{ type: "text" as const, text }] })
        const a = yield* Effect.promise(() => request(tmp.path, session.id, "message", input(aID, "A tool request")))
        const aBody = a.json()
        yield* Effect.promise(() => entered.promise)
        const b = yield* Effect.promise(() => request(tmp.path, session.id, "prompt_async", input(bID, "B newest request")))
        expect(b.status).toBe(202)
        release.resolve()
        const live = yield* Effect.promise(() => aBody)
        expect(live.info).toMatchObject({ parentID: bID })
        const owned = receipts(session.id)
        const aReceipt = owned.find(row => row.input_message_id === aID)!, bReceipt = owned.find(row => row.input_message_id === bID)!
        expect(aReceipt.run_id).toBe(bReceipt.run_id)
        expect(aReceipt.outcome_message_id).toBe(live.info.id)
        expect(bReceipt.outcome_message_id).toBe(live.info.id)
        expect(aReceipt.delivery_message_id).not.toBe(bReceipt.delivery_message_id)
        expect(owned.every(row => row.state === "settled" && row.consumed)).toBe(true)
        const next = yield* prompt.prompt({ sessionID: session.id, ...input(cID, "C independent request") })
        expect(next.info).toMatchObject({ parentID: cID })
        expect(next.parts.some(part => part.type === "text" && part.text === "RC independent outcome")).toBe(true)
        const late = yield* prompt.prompt({ sessionID: session.id, ...input(aID, "A tool request") }).pipe(Effect.timeout("5 seconds"))
        expect(late).toEqual(live)
        expect(late.info).not.toMatchObject({ parentID: cID })
        expect(stub.captures).toHaveLength(3)
        expect((yield* sessions.messages({ sessionID: session.id })).filter(message => message.info.role === "assistant")).toHaveLength(3)
        expect(yield* SessionStatus.Service.use(status => status.get(session.id))).toEqual({ type: "idle" })
      })) })
    } finally { release.resolve(); await stub.stop() }
  }, 30_000)

  // [TP-RUN-R1C-08] A consumed cancellation has a delivery assistant. Late
  // registration must return that interrupted result, retain the receipt, and
  // never execute the original input again in the next epoch.
  test("late cancelled consumed receipt returns its delivery assistant without rerunning", async () => {
    await using tmp = await tmpdir({ git: true })
    const encoder = new TextEncoder()
    const liveStream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const line of textStopResponse("partial A before cancellation").slice(0, 2)) controller.enqueue(encoder.encode(line))
    } })
    const stub = startScriptedLLMServer([{ lines: [], stream: liveStream }])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "Late cancelled delivery" })
        const aID = MessageID.ascending()
        const input = { messageID: aID, agent: "build", model, parts: [{ type: "text" as const, text: "A cancellable request" }] }
        const a = yield* Effect.promise(() => request(tmp.path, session.id, "message", input))
        const aBody = a.json()
        for (let i = 0; i < 200; i++) {
          if ((yield* sessions.messages({ sessionID: session.id })).some(message => message.parts.some(part => part.type === "text" && part.text === "partial A before cancellation"))) break
          yield* Effect.sleep("10 millis")
        }
        expect(receipts(session.id)).toMatchObject([{ state: "claimed", consumed: true, delivery_message_id: expect.any(String) }])
        yield* prompt.cancel(session.id)
        const live = yield* Effect.promise(() => aBody)
        const before = receipts(session.id)
        expect(before).toMatchObject([{ state: "cancelled", outcome: "interrupted", consumed: true, error: null }])
        expect(live.info).toMatchObject({ id: before[0].delivery_message_id, parentID: aID, role: "assistant", error: { name: "MessageAbortedError" } })
        const late = yield* prompt.prompt({ sessionID: session.id, ...input }).pipe(Effect.timeout("5 seconds"))
        // The existing idle sweep may add completed to an aborted shell;
        // replay still returns its same durable delivery and preserves content.
        expect(late.info).toMatchObject({ id: live.info.id, parentID: aID, error: live.info.role === "assistant" ? live.info.error : undefined })
        expect(late.parts).toEqual(live.parts)
        expect(late).toEqual((yield* sessions.messages({ sessionID: session.id })).find(message => message.info.id === live.info.id)!)
        expect(receipts(session.id)).toEqual(before)
        expect(stub.captures).toHaveLength(1)
        expect((yield* sessions.messages({ sessionID: session.id })).filter(message => message.info.role === "assistant")).toHaveLength(1)
        expect(yield* SessionStatus.Service.use(status => status.get(session.id))).toEqual({ type: "idle" })
      })) })
    } finally { await stub.stop() }
  }, 30_000)

  // [TP-RUN-R1C-08] A receipt fixes its original owner result. Explicit Resume
  // creates another run on the same parent and must not replace old replay.
  for (const result of ["quota", "success"] as const) for (const sameMillis of [false, true]) test(`old receipt keeps its original result after same-parent Resume (result=${result}, sameMillis=${sameMillis})`, async () => {
    await using tmp = await tmpdir({ git: true })
    const denied = () => ({ status: 403, lines: [JSON.stringify({ error: { message: "same quota rejection", type: "usage_not_included" } })] })
    const stub = startScriptedLLMServer([denied(), result === "quota" ? denied() : { lines: textStopResponse("new resume success") }])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "Receipt across same parent resume" })
        const id = MessageID.ascending()
        const input = { sessionID: session.id, messageID: id, agent: "build", model, parts: [{ type: "text" as const, text: "original A" }] }
        const clock = sameMillis ? spyOn(Date, "now").mockReturnValue(Date.now()) : undefined
        try {
          const original = yield* prompt.prompt(input)
          expect(original.info).toMatchObject({ role: "assistant", parentID: id, error: { name: "APIError" } })
          const fixedReceipt = receipts(session.id)
          expect(fixedReceipt).toMatchObject([{ state: "settled", consumed: true, outcome: "assistant_error",
            delivery_message_id: original.info.id, outcome_message_id: original.info.id }])
          const resumed = yield* prompt.resume({ sessionID: session.id, assistantMessageID: original.info.id })
          expect(resumed.info).toMatchObject({ role: "assistant", parentID: id })
          if (result === "quota") expect(resumed.info).toMatchObject({ error: { name: "APIError" } })
          else expect(resumed.parts.some(part => part.type === "text" && part.text === "new resume success")).toBe(true)
          expect(resumed.info.id).not.toBe(original.info.id)
          if (sameMillis) expect(Database.use(db => db.select({ created: MessageTable.time_created }).from(MessageTable).where(eq(MessageTable.id, resumed.info.id)).get())!.created).toBe(fixedReceipt[0].time_updated)
          expect(receipts(session.id)).toEqual(fixedReceipt)
          const late = yield* prompt.prompt(input).pipe(Effect.timeout("5 seconds"))
          expect(stub.captures).toHaveLength(2)
          expect(receipts(session.id)).toEqual(fixedReceipt)
          expect(late.info.id).toBe(original.info.id)
          expect(late.parts).toEqual(original.parts)
        } finally { clock?.mockRestore() }
      })) })
    } finally { await stub.stop() }
  }, 30_000)

  // [TP-RUN-R1C-08] Missing outcome history is explicit failure. A newer
  // same-parent answer cannot satisfy a reference to deleted original work.
  test("deleted outcome rejects replay after Resume and receipt GC leaves new prompts usable", async () => {
    await using tmp = await tmpdir({ git: true })
    const denied = () => ({ status: 403, lines: [JSON.stringify({ error: { message: "quota before deleted result", type: "usage_not_included" } })] })
    const stub = startScriptedLLMServer([denied(), { lines: textStopResponse("new answer after resume") },
      { lines: textStopResponse("fresh prompt after receipt GC") }])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "Deleted original receipt outcome" })
        const id = MessageID.ascending()
        const input = { sessionID: session.id, messageID: id, agent: "build", model, parts: [{ type: "text" as const, text: "original input" }] }
        const original = yield* prompt.prompt(input)
        const resumed = yield* prompt.resume({ sessionID: session.id, assistantMessageID: original.info.id })
        expect(resumed.info.id).not.toBe(original.info.id)
        yield* sessions.removeMessage({ sessionID: session.id, messageID: original.info.id })
        const response = yield* Effect.promise(() => request(tmp.path, session.id, "prompt_async", input))
        expect(response.status).toBe(404)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ name: "NotFoundError" })
        expect(stub.captures).toHaveLength(2)
        expect(receipts(session.id)[0].outcome_message_id).toBe(original.info.id)
        // Terminal receipt GC is a durable lifecycle boundary. Failed replay
        // must release its local registration before a later request scans it.
        Database.use(db => db.delete(InboxTable).where(eq(InboxTable.receiver_session_id, session.id)).run())
        const next = yield* prompt.prompt({ sessionID: session.id, messageID: MessageID.ascending(), agent: "build", model,
          parts: [{ type: "text" as const, text: "independent new input" }] }).pipe(Effect.timeout("5 seconds"))
        expect(next.info.role === "assistant" && next.info.error).toBeUndefined()
        expect(next.parts.some(part => part.type === "text" && part.text === "fresh prompt after receipt GC")).toBe(true)
        expect(stub.captures).toHaveLength(3)
        expect(yield* SessionStatus.Service.use(s => s.get(session.id))).toEqual({ type: "idle" })
      })) })
    } finally { await stub.stop() }
  }, 30_000)

})
