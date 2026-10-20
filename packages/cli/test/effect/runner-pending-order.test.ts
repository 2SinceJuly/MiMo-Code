import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { Runner } from "../../src/effect"
import { it } from "../lib/effect"

// onRegistered runs under the scheduling lock. Await it before mutating input
// or releasing its predecessor so the asserted state is genuinely registered.
const attach = Effect.fnUntraced(function* (
  runner: Runner.Runner<string>,
  work: Effect.Effect<string>,
  order?: Runner.PendingOrder,
) {
  const registered = yield* Deferred.make<void>()
  const fiber = yield* runner.ensureRunning(work, () => Deferred.doneUnsafe(registered, Effect.void), order).pipe(Effect.exit, Effect.forkChild)
  yield* Deferred.await(registered)
  return fiber
})

const successful = (exit: Exit.Exit<string, never>, value: string) => {
  expect(Exit.isSuccess(exit)).toBe(true)
  if (Exit.isSuccess(exit)) expect(exit.value).toBe(value)
}

describe("ordered prompt pending", () => {
  // [TP-RUN-R1C-08] Selection follows persisted input order, not attachment order.
  for (const reverse of [false, true]) it.live(`latest input owns shared pending with reverse registration=${reverse}`, Effect.gen(function* () {
    const runner = Runner.make<string>(yield* Scope.Scope)
    const release = yield* Deferred.make<void>()
    const current = yield* attach(runner, Deferred.await(release).pipe(Effect.as("current")))
    const ran: string[] = []
    const work = (value: string) => Effect.sync(() => { ran.push(value); return value })
    const older = [10, "msg_old"] as const, newer = [20, "msg_new"] as const
    const first = yield* attach(runner, work(reverse ? "newer" : "older"), reverse ? newer : older)
    const second = yield* attach(runner, work(reverse ? "older" : "newer"), reverse ? older : newer)
    yield* Deferred.succeed(release, undefined)
    successful(yield* Fiber.join(current), "current")
    successful(yield* Fiber.join(first), "newer")
    successful(yield* Fiber.join(second), "newer")
    expect(ran).toEqual(["newer"])
    expect(runner.busy).toBe(false)
  }))

  // [TP-RUN-R1C-08] Same-time ordering uses SQLite BINARY order; the Runner owns a copy.
  it.live("same timestamp uses message ID and snapshots registered caller order", Effect.gen(function* () {
    const runner = Runner.make<string>(yield* Scope.Scope)
    const release = yield* Deferred.make<void>()
    const current = yield* attach(runner, Deferred.await(release).pipe(Effect.as("current")))
    const older: [number, string] = [10, "msg_Z"]
    const first = yield* attach(runner, Effect.succeed("older"), older)
    older[0] = 1000
    const second = yield* attach(runner, Effect.succeed("newer"), [10, "msg_a"])
    yield* Deferred.succeed(release, undefined)
    successful(yield* Fiber.join(current), "current")
    successful(yield* Fiber.join(first), "newer")
    successful(yield* Fiber.join(second), "newer")
  }))

  // [TP-RUN-R1C-08] Generic-only work keeps first; a concrete input owner wins mixed joins.
  for (const mixed of ["neither", "first", "second"] as const) it.live(`running pending preserves ordered identity in mixed joins (${mixed})`, Effect.gen(function* () {
    const runner = Runner.make<string>(yield* Scope.Scope)
    const release = yield* Deferred.make<void>()
    const current = yield* attach(runner, Deferred.await(release).pipe(Effect.as("current")))
    const ran: string[] = []
    const work = (value: string) => Effect.sync(() => { ran.push(value); return value })
    const first = yield* attach(runner, work("first"), mixed === "first" ? [10, "msg_first"] : undefined)
    const second = yield* attach(runner, work("second"), mixed === "second" ? [20, "msg_second"] : undefined)
    yield* Deferred.succeed(release, undefined)
    const selected = mixed === "second" ? "second" : "first"
    successful(yield* Fiber.join(current), "current")
    successful(yield* Fiber.join(first), selected)
    successful(yield* Fiber.join(second), selected)
    expect(ran).toEqual([selected])
  }))

  // [TP-RUN-R1C-08] Generic shell joins retain latest; mixed joins keep actual input ownership.
  for (const mixed of ["neither", "first", "second"] as const) it.live(`shell pending preserves ordered identity in mixed joins (${mixed})`, Effect.gen(function* () {
    const runner = Runner.make<string>(yield* Scope.Scope)
    const entered = yield* Deferred.make<void>(), release = yield* Deferred.make<void>()
    const shell = yield* runner.startShell(Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)), Effect.as("shell"),
    )).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const ran: string[] = []
    const work = (value: string) => Effect.sync(() => { ran.push(value); return value })
    const first = yield* attach(runner, work("first"), mixed === "first" ? [10, "msg_first"] : undefined)
    const second = yield* attach(runner, work("second"), mixed === "second" ? [20, "msg_second"] : undefined)
    yield* Deferred.succeed(release, undefined)
    const selected = mixed === "first" ? "first" : "second"
    expect(yield* Fiber.join(shell)).toBe("shell")
    successful(yield* Fiber.join(first), selected)
    successful(yield* Fiber.join(second), selected)
    expect(ran).toEqual([selected])
    expect(runner.busy).toBe(false)
  }))

  // [TP-RUN-R1C-08] Shell pending selects persisted latest despite reverse registration.
  for (const reverse of [false, true]) it.live(`shell pending preserves ordered owner (reverse=${reverse})`, Effect.gen(function* () {
    const runner = Runner.make<string>(yield* Scope.Scope)
    const entered = yield* Deferred.make<void>(), release = yield* Deferred.make<void>()
    const shell = yield* runner.startShell(Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)), Effect.as("shell"),
    )).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const ran: string[] = []
    const work = (value: string) => Effect.sync(() => { ran.push(value); return value })
    const first = yield* attach(runner, work(reverse ? "newer" : "older"), reverse ? [20, "msg_new"] : [10, "msg_old"])
    const second = yield* attach(runner, work(reverse ? "older" : "newer"), reverse ? [10, "msg_old"] : [20, "msg_new"])
    expect(runner.state._tag).toBe("ShellThenRun")
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(shell)).toBe("shell")
    successful(yield* Fiber.join(first), "newer")
    successful(yield* Fiber.join(second), "newer")
    expect(ran).toEqual(["newer"])
    expect(runner.busy).toBe(false)
  }))

  // [TP-RUN-R1C-08] Cancel retires the shared signal without running merged work.
  it.live("cancellation closes registered merged pending without running it", Effect.gen(function* () {
    const runner = Runner.make<string>(yield* Scope.Scope)
    const entered = yield* Deferred.make<void>()
    const current = yield* attach(runner, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
    yield* Deferred.await(entered)
    const ran: string[] = []
    const work = (value: string) => Effect.sync(() => { ran.push(value); return value })
    const first = yield* attach(runner, work("older"), [10, "msg_old"])
    const second = yield* attach(runner, work("newer"), [20, "msg_new"])
    yield* runner.cancel
    expect(Exit.isFailure(yield* Fiber.join(current))).toBe(true)
    expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
    expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true)
    expect(ran).toEqual([])
    expect(runner.busy).toBe(false)
    expect(yield* runner.ensureRunning(Effect.succeed("next"), undefined, [30, "msg_next"])).toBe("next")
  }))

  // [TP-RUN-R1C-08] Once a slot starts, later inputs cannot replace its owner.
  it.live("input arriving after pending starts gets a separate next slot", Effect.gen(function* () {
    const runner = Runner.make<string>(yield* Scope.Scope)
    const releaseCurrent = yield* Deferred.make<void>(), entered = yield* Deferred.make<void>(), releasePending = yield* Deferred.make<void>()
    const current = yield* attach(runner, Deferred.await(releaseCurrent).pipe(Effect.as("current")))
    const pending = yield* attach(runner, Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(releasePending)), Effect.as("pending"),
    ), [20, "msg_pending"])
    yield* Deferred.succeed(releaseCurrent, undefined)
    yield* Deferred.await(entered)
    const next = yield* attach(runner, Effect.succeed("next"), [30, "msg_next"])
    yield* Deferred.succeed(releasePending, undefined)
    successful(yield* Fiber.join(current), "current")
    successful(yield* Fiber.join(pending), "pending")
    successful(yield* Fiber.join(next), "next")
    expect(runner.busy).toBe(false)
  }))

  // [TP-RUN-R1C-08] Cancelling waits for finalizers and carries order into its next slot.
  it.live("arrival during cancelling preserves order after finalizer handoff", Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const entered = yield* Deferred.make<void>(), finalizing = yield* Deferred.make<void>(), releaseFinalizer = yield* Deferred.make<void>()
    const releaseBlocker = yield* Deferred.make<void>()
    const ran: string[] = []
    let runner!: Runner.Runner<string>
    let blocker: Fiber.Fiber<Exit.Exit<string, never>> | undefined
    let installBlocker = true
    runner = Runner.make<string>(scope, {
      onIdle: Effect.gen(function* () {
        if (!installBlocker) return
        installBlocker = false
        // Register before the cancelling waiter retries, making that waiter's
        // retained order observable in a real pending comparison.
        blocker = yield* runner.ensureRunning(Deferred.await(releaseBlocker).pipe(Effect.as("blocker"))).pipe(Effect.exit, Effect.forkIn(scope, { startImmediately: true }))
      }),
    })
    const current = yield* attach(runner, Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(releaseFinalizer)))),
    ))
    yield* Deferred.await(entered)
    const cancelling = yield* runner.cancel.pipe(Effect.forkChild)
    yield* Deferred.await(finalizing)
    const registered = yield* Deferred.make<void>()
    const future = yield* runner.ensureRunning(Effect.sync(() => { ran.push("newer"); return "newer" }),
      () => Deferred.doneUnsafe(registered, Effect.void), [30, "msg_newer"]).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    expect(runner.state._tag).toBe("Cancelling")
    expect(yield* Deferred.isDone(registered)).toBe(false)
    expect(ran).toEqual([])
    yield* Deferred.succeed(releaseFinalizer, undefined)
    yield* Deferred.await(registered)
    const older = yield* attach(runner, Effect.sync(() => { ran.push("older"); return "older" }), [20, "msg_older"])
    yield* Deferred.succeed(releaseBlocker, undefined)
    yield* Fiber.join(cancelling)
    expect(Exit.isFailure(yield* Fiber.join(current))).toBe(true)
    expect(blocker).toBeDefined()
    successful(yield* Fiber.join(blocker!), "blocker")
    successful(yield* Fiber.join(future), "newer")
    successful(yield* Fiber.join(older), "newer")
    expect(ran).toEqual(["newer"])
    expect(runner.busy).toBe(false)
  }))

  // [TP-RUN-R1C-08] Separate parent/actor Runners keep their owners and cancellation.
  it.live("ordered work in distinct runners remains isolated", Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const parent = Runner.make<string>(scope), actor = Runner.make<string>(scope)
    const releaseParent = yield* Deferred.make<void>(), releaseActor = yield* Deferred.make<void>()
    const parentCurrent = yield* attach(parent, Deferred.await(releaseParent).pipe(Effect.as("parent")))
    const actorCurrent = yield* attach(actor, Deferred.await(releaseActor).pipe(Effect.as("actor")))
    const parentPending = yield* attach(parent, Effect.succeed("parent-pending"), [10, "msg_parent"])
    const actorPending = yield* attach(actor, Effect.succeed("actor-pending"), [100, "msg_actor"])
    yield* parent.cancel
    expect(Exit.isFailure(yield* Fiber.join(parentCurrent))).toBe(true)
    expect(Exit.isFailure(yield* Fiber.join(parentPending))).toBe(true)
    expect(actor.busy).toBe(true)
    yield* Deferred.succeed(releaseActor, undefined)
    successful(yield* Fiber.join(actorCurrent), "actor")
    successful(yield* Fiber.join(actorPending), "actor-pending")
    expect(actor.busy).toBe(false)
  }))
})
