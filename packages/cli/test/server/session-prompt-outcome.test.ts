import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MCP } from "../../src/mcp"
import { Provider } from "../../src/provider"
import { Plugin } from "../../src/plugin"
import { SessionRunState } from "../../src/session/run-state"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionStatus } from "../../src/session/status"
import { MessageTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ResumeTestHooks } from "../../src/session/resume-test-hooks"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })
afterEach(async () => { mock.restore(); ResumeTestHooks.reset(); await Instance.disposeAll() })
const model = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }
const config = (origin: string) => ({ enabled_providers: ["alibaba"],
  provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } } },
  agent: { build: { model: "alibaba/qwen-plus" } }, checkpoint: { thresholds: [] } })
function request(app: ReturnType<typeof Server.Default>["app"], directory: string, id: string, route: string, body: unknown) {
  return Promise.resolve(app.request(`/session/${id}/${route}?directory=${encodeURIComponent(directory)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }))
}

describe("session prompt execution outcomes", () => {
  // [TP-RUN-R1C-05][TP-RUN-R1C-07] Validation fails before durable input, with a structured HTTP rejection.
  for (const route of ["prompt_async", "message"]) {
    test(`${route} rejects a missing session and missing agent before acceptance`, async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "input admission" })
        const app = Server.Default().app
        const body = { agent: "missing-agent", model, parts: [{ type: "text", text: "unsaved question" }] }
        const missing = yield* Effect.promise(() => request(app, tmp.path, SessionID.descending(), route, body))
        expect(missing.status).toBe(404)
        expect(yield* Effect.promise(() => missing.json())).toMatchObject({ name: "NotFoundError" })
        const invalid = yield* Effect.promise(() => request(app, tmp.path, session.id, route, body))
        expect(invalid.status).toBe(500)
        expect(yield* Effect.promise(() => invalid.json())).toMatchObject({ name: "UnknownError", data: { message: expect.stringContaining("Agent not found") } })
        expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(0)
        expect(yield* SessionStatus.Service.use(status => status.get(session.id))).toEqual({ type: "idle" })
      })) })
    })
  }

  // [TP-RUN-R1C-05][TP-RUN-R1C-07] One owner error is durable before idle; the next request still succeeds.
  for (const route of ["prompt_async", "message"]) {
    test(`${route} persists a pre-model owner exception once and permits the next request`, async () => {
      await using tmp = await tmpdir({ git: true })
      const stub = startScriptedLLMServer([{ lines: textStopResponse("next request succeeded") }])
      try {
        await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
        await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "owner failure" })
          const id = MessageID.ascending()
          ResumeTestHooks.beforeStep0ParentCheck = () => Effect.die(new Error("owner preparation failed"))
          const errors: unknown[] = []
          const statuses: string[] = []
          const offError = Bus.subscribe(Session.Event.Error, event => { if (event.properties.sessionID === session.id) errors.push(event.properties.error) })
          const offStatus = Bus.subscribe(SessionStatus.Event.Status, event => { if (event.properties.sessionID === session.id) statuses.push(event.properties.status.type) })
          const app = Server.Default().app
          const response = yield* Effect.promise(() => request(app, tmp.path, session.id, route,
            { messageID: id, agent: "build", model, parts: [{ type: "text", text: "first question" }] }))
          expect(response.status).toBe(route === "message" ? 200 : 204)
          if (route === "message") expect(yield* Effect.promise(() => response.json())).toMatchObject({ info: {
            role: "assistant", parentID: id, error: { data: { message: "owner preparation failed" } },
          } })
          for (let i = 0; i < 100; i++) {
            if (errors.length && (yield* SessionStatus.Service.use(status => status.get(session.id))).type === "idle") break
            yield* Effect.sleep("20 millis")
          }
          const after = yield* sessions.messages({ sessionID: session.id })
          const failed = after.filter(message => message.info.role === "assistant")
          expect(failed).toHaveLength(1)
          expect(failed[0]?.info).toMatchObject({ parentID: id, error: { data: { message: "owner preparation failed" } }, time: { completed: expect.any(Number) } })
          expect(errors).toHaveLength(1)
          expect(statuses[0]).toBe("busy")
          expect(statuses.at(-1)).toBe("idle")
          expect(stub.captures).toHaveLength(0)
          ResumeTestHooks.reset()
          const next = yield* Effect.promise(() => request(app, tmp.path, session.id, "message",
            { agent: "build", model, parts: [{ type: "text", text: "next question" }] }))
          expect(next.status).toBe(200)
          const nextBody = yield* Effect.promise(() => next.json())
          expect(nextBody.info.error).toBeUndefined()
          expect(nextBody.parts.some((part: { text?: string }) => part.text === "next request succeeded")).toBe(true)
          expect((yield* sessions.messages({ sessionID: session.id })).find(message => message.info.id === failed[0]?.info.id)).toEqual(failed[0])
          offError(); offStatus()
        })) })
      } finally { stub.stop() }
    })
  }

  // [TP-SR-R21-35] A real 202 is followed by an exact-parent durable failure, then idle.
  test("resume 202 settles preparation failure without rewriting the old answer or another actor", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "resume failure" })
        const user = yield* sessions.updateMessage({ id: MessageID.ascending(), role: "user", sessionID: session.id,
          agent: "build", model, time: { created: Date.now() } })
        yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: user.id, type: "text", text: "original question" })
        const old = yield* sessions.updateMessage({ id: MessageID.ascending(), role: "assistant", sessionID: session.id,
          parentID: user.id, agent: "build", mode: "build", path: { cwd: tmp.path, root: tmp.path },
          providerID: model.providerID, modelID: model.modelID, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now() } })
        yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: old.id, type: "text", text: "preserved partial answer" })
        const actor = yield* sessions.updateMessage({ ...old, id: MessageID.ascending(), agentID: "worker", time: { created: Date.now() } })
        let release!: () => void
        const gate = new Promise<void>(done => { release = done })
        ResumeTestHooks.afterAdmissionBeforeCleanup = () => Effect.promise(() => gate).pipe(Effect.andThen(Effect.die(new Error("resume preparation failed"))))
        const errors: unknown[] = []
        const idleErrors: number[] = []
        const offError = Bus.subscribe(Session.Event.Error, event => { if (event.properties.sessionID === session.id) errors.push(event.properties.error) })
        const offStatus = Bus.subscribe(SessionStatus.Event.Status, event => { if (event.properties.sessionID === session.id && event.properties.status.type === "idle") idleErrors.push(errors.length) })
        const response = yield* Effect.promise(() => request(Server.Default().app, tmp.path, session.id, "resume", { assistantMessageID: old.id }))
        expect(response.status).toBe(202)
        const newer = yield* sessions.updateMessage({ ...user, id: MessageID.ascending(), time: { created: Date.now() } })
        yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: newer.id, type: "text", text: "later question" })
        release()
        for (let i = 0; i < 100 && idleErrors.length === 0; i++) yield* Effect.sleep("20 millis")
        const after = yield* sessions.messages({ sessionID: session.id, agentID: "*" })
        expect(after.filter(message => message.info.role === "user")).toHaveLength(2)
        expect(after.find(message => message.info.id === old.id)).toMatchObject({ info: old, parts: [{ text: "preserved partial answer" }] })
        expect(after.find(message => message.info.id === actor.id)?.info).toEqual(actor)
        expect(after.filter(message => message.info.role === "assistant" && message.info.error)).toHaveLength(1)
        expect(after.find(message => message.info.role === "assistant" && message.info.error)?.info).toMatchObject({ parentID: user.id, error: { data: { message: "resume preparation failed" } } })
        expect(idleErrors).toEqual([1])
        expect(stub.captures).toHaveLength(0)
        offError(); offStatus()
      })) })
    } finally { stub.stop() }
  })

  // [TP-RUN-R1C-05][TP-RUN-R1C-07] Admission and execution share one fiber; before execution cancellation cannot leak work.
  test("startPrompt waits with durable input and starts no model work until result is consumed", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "admission ownership" })
        const prompt = yield* SessionPrompt.Service
        const started = yield* prompt.startPrompt({ sessionID: session.id, agent: "build", model, parts: [{ type: "text", text: "cancel before execution" }] })
        expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(1)
        expect(yield* SessionStatus.Service.use(status => status.get(session.id))).toEqual({ type: "idle" })
        yield* started.cancel
        yield* Effect.sleep("30 millis")
        expect(stub.captures).toHaveLength(0)
        expect(yield* SessionStatus.Service.use(status => status.get(session.id))).toEqual({ type: "idle" })
        expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(1)
      })) })
    } finally { stub.stop() }
  })
})

// [TP-SR-R21-35] Once resume has delivered success, cleanup defects do not become another assistant outcome.
test("resume preserves a successful delivery when post-turn cleanup fails", async () => {
  await using tmp = await tmpdir({ git: true })
  const stub = startScriptedLLMServer([{ lines: textStopResponse("successful resumed answer") }])
  try {
    await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
    await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "resume cleanup failure" })
      const user = yield* sessions.updateMessage({ id: MessageID.ascending(), role: "user", sessionID: session.id,
        agent: "build", model, time: { created: Date.now() } })
      yield* sessions.updatePart({ id: PartID.ascending(), sessionID: session.id, messageID: user.id, type: "text", text: "resume my question" })
      const old = yield* sessions.updateMessage({ id: MessageID.ascending(), role: "assistant", sessionID: session.id,
        parentID: user.id, agent: "build", mode: "build", path: { cwd: tmp.path, root: tmp.path },
        providerID: model.providerID, modelID: model.modelID, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now() } })
      spyOn(MCP, "releaseTurnClients").mockImplementation(() => Effect.die(new Error("resume cleanup failed")))
      const exit = yield* prompt.resume({ sessionID: session.id, assistantMessageID: old.id }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const after = yield* sessions.messages({ sessionID: session.id })
      expect(after.filter(message => message.info.role === "assistant" && message.info.error)).toHaveLength(0)
      const answers = after.filter(message => message.info.role === "assistant" && message.info.id !== old.id)
      expect(answers).toHaveLength(1)
      expect(answers[0]?.info).toMatchObject({ parentID: user.id, time: { completed: expect.any(Number) } })
      expect(answers[0]?.info.role === "assistant" && answers[0].info.error).toBeUndefined()
      expect(answers[0]?.parts.some(part => part.type === "text" && part.text === "successful resumed answer")).toBe(true)
      expect(yield* SessionStatus.Service.use(status => status.get(session.id))).toEqual({ type: "idle" })
      expect(stub.captures).toHaveLength(1)
    })) })
  } finally { stub.stop() }
})

// [TP-RUN-R1C-07] Live, unbound exception metadata cannot acquire host retry authority during settlement.
test("settled live preparation error strips an unbound host retry stamp", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const session = yield* sessions.create({ title: "unbound error" })
    const forged = new MessageV2.APIError({ message: "ordinary live exception", isRetryable: false,
      hostCode: "forged.code", hostRetryClass: "persistent" }).toObject()
    spyOn(sessions, "touch").mockImplementation(() => Effect.die(forged))
    const result = yield* prompt.prompt({ sessionID: session.id, agent: "build", model, parts: [{ type: "text", text: "save before failure" }] })
    expect(result.info).toMatchObject({ role: "assistant", error: { data: { message: "ordinary live exception", isRetryable: false } } })
    expect(result.info.role === "assistant" && result.info.error?.data.hostCode).toBeUndefined()
    expect(result.info.role === "assistant" && result.info.error?.data.hostRetryClass).toBeUndefined()
  })) })
})

// [TP-RUN-R1C-05][TP-RUN-R1C-07] Known-parent preparation failures do not masquerade as rejected, unsaved inputs.
for (const boundary of ["touch", "part", "dispatch", "model", "language", "post"] as const) {
  test(`prompt settles the exact current message at ${boundary} boundary`, async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: textStopResponse("preserved successful answer") }])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "boundary settlement" })
        const id = MessageID.ascending()
        const fail = () => Effect.die(new Error(`${boundary} boundary failed`))
        const dependency = boundary === "dispatch" ? yield* SessionRunState.Service : boundary === "language" ? yield* Provider.Service
          : boundary === "post" ? MCP : sessions
        const mocked = boundary === "touch" ? spyOn(sessions, "touch").mockImplementation(fail)
          : boundary === "part" ? spyOn(sessions, "updatePart").mockImplementation(fail)
          : boundary === "dispatch" ? spyOn(dependency as SessionRunState.Interface, "ensureRunning").mockImplementation(fail)
          : boundary === "language" ? spyOn(dependency as Provider.Interface, "getLanguage").mockImplementation(fail)
          : boundary === "post" ? spyOn(MCP, "releaseTurnClients").mockImplementation(fail) : undefined
        const input = { sessionID: session.id, messageID: id, agent: "build", model: boundary === "model"
          ? { ...model, modelID: ModelID.make("missing-model") } : model, parts: [{ type: "text" as const, text: "boundary question" }] }
        const exit = yield* prompt.prompt(input).pipe(Effect.exit)
        mocked?.mockRestore()
        const messages = yield* sessions.messages({ sessionID: session.id })
        const assistants = messages.filter(message => message.info.role === "assistant")
        expect(assistants).toHaveLength(1)
        expect(assistants[0]?.info).toMatchObject({ parentID: id, time: { completed: expect.any(Number) } })
        if (boundary === "post") {
          expect(Exit.isFailure(exit)).toBe(true)
          expect(assistants[0]?.info.role === "assistant" && assistants[0].info.error).toBeUndefined()
          expect(assistants[0]?.parts.some(part => part.type === "text" && part.text === "preserved successful answer")).toBe(true)
        } else {
          expect(Exit.isSuccess(exit)).toBe(true)
          expect(assistants[0]?.info).toMatchObject({ error: { data: { message: expect.stringContaining(boundary === "model" ? "Model not found" : `${boundary} boundary failed`) } } })
          expect(stub.captures).toHaveLength(0)
        }
        expect(yield* SessionStatus.Service.use(status => status.get(session.id))).toEqual({ type: "idle" })
      })) })
    } finally { stub.stop() }
  })
}

// [TP-RUN-R1C-07] Parent deletion during accepted work cannot recreate it or return a successful empty JSON body.
for (const remove of ["parent", "session"] as const) {
  test(`message body rejects after ${remove} deletion and creates no orphan error assistant`, async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([])
    try {
      await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
      await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "deleted failure target" })
        const id = MessageID.ascending()
        let entered!: () => void
        const reached = new Promise<void>(done => { entered = done })
        let release!: () => void
        const gate = new Promise<void>(done => { release = done })
        ResumeTestHooks.beforeStep0ParentCheck = () => Effect.sync(entered).pipe(Effect.andThen(Effect.promise(() => gate)), Effect.andThen(Effect.die(new Error("failure after delete"))))
        const response = yield* Effect.promise(() => request(Server.Default().app, tmp.path, session.id, "message",
          { messageID: id, agent: "build", model, parts: [{ type: "text", text: "delete while preparing" }] }))
        const body = response.json().then(value => ({ ok: true, value }), error => ({ ok: false, error }))
        yield* Effect.promise(() => reached)
        if (remove === "parent") yield* sessions.removeMessage({ sessionID: session.id, messageID: id })
        else yield* sessions.remove(session.id)
        release()
        expect((yield* Effect.promise(() => body)).ok).toBe(false)
        expect(Database.use(db => db.select().from(MessageTable).where(eq(MessageTable.session_id, session.id)).all())).toHaveLength(0)
        expect(stub.captures).toHaveLength(0)
      })) })
    } finally { stub.stop() }
  })
}

// [TP-RUN-R1C-05] Three sends share the existing pending Runner; one owner settles the selected newest parent.
test("multiple pending prompts settle one selected user and preserve the earlier answer", async () => {
  await using tmp = await tmpdir({ git: true })
  const stub = startScriptedLLMServer([{ lines: textStopResponse("first answer") }])
  try {
    await Bun.write(`${tmp.path}/mimocode.json`, JSON.stringify(config(stub.origin)))
    await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const plugin = yield* Plugin.Service
      const session = yield* sessions.create({ title: "pending owner identity" })
      let entered!: () => void
      const reached = new Promise<void>(done => { entered = done })
      let release!: () => void
      const gate = new Promise<void>(done => { release = done })
      const trigger = plugin.trigger
      const mocked = spyOn(plugin, "trigger").mockImplementation((...args) => {
        if (args[0] === "session.post") return Effect.sync(entered).pipe(Effect.andThen(Effect.promise(() => gate)), Effect.andThen(trigger(...args)))
        return trigger(...args)
      })
      const a = yield* prompt.prompt({ sessionID: session.id, agent: "build", model, parts: [{ type: "text", text: "first question" }] }).pipe(Effect.forkChild)
      yield* Effect.promise(() => reached)
      const bID = MessageID.ascending()
      const cID = MessageID.ascending()
      const b = yield* prompt.prompt({ sessionID: session.id, messageID: bID, agent: "build", model, parts: [{ type: "text", text: "second question" }] }).pipe(Effect.forkChild)
      const c = yield* prompt.prompt({ sessionID: session.id, messageID: cID, agent: "build", model, parts: [{ type: "text", text: "third question" }] }).pipe(Effect.forkChild)
      for (let i = 0; i < 100; i++) {
        if ((yield* sessions.messages({ sessionID: session.id })).filter(message => message.info.role === "user").length === 3) break
        yield* Effect.sleep("10 millis")
      }
      const provider = yield* Provider.Service
      const language = spyOn(provider, "getLanguage").mockImplementation(() => Effect.die(new Error("pending owner failed")))
      release()
      const first = yield* Fiber.join(a)
      const second = yield* Fiber.join(b)
      const third = yield* Fiber.join(c)
      mocked.mockRestore(); language.mockRestore()
      expect(first.info.role === "assistant" && first.info.error).toBeUndefined()
      expect(second).toEqual(third)
      expect(third.info).toMatchObject({ parentID: cID, error: { data: { message: "pending owner failed" } } })
      const after = yield* sessions.messages({ sessionID: session.id })
      expect(after.filter(message => message.info.role === "assistant" && message.info.error)).toHaveLength(1)
      expect(after.find(message => message.info.id === first.info.id)).toEqual(first)
      expect(stub.captures).toHaveLength(1)
    })) })
  } finally { stub.stop() }
})
