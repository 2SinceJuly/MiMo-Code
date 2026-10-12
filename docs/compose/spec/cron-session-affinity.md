---
feature: cron-session-affinity
status: in-progress
updated: 2026-10-12
branch: fix/cron-session-affinity
commits: 
---

# Cron Session Affinity

## Report

## [S1] Problem

Users (notably from mimo-desktop multi-session hosts) report that scheduled
`cron` / `loop` prompts fire into the wrong session. Code confirms this:

- `CronBridge.onFire` always injects into `handle.sessionID` (the first session
  that called `start`) and never reads `task.createdBySessionId`.
- `CronBridge` is a single-slot singleton; a second session's `start` is a no-op,
  so every fire in the process lands on the first session.
- `scheduler.armLoop` never writes `createdBySessionId`, so loop tasks have no
  owner stamp at all.
- `get` / `delete` / `rename` only apply a session filter when the caller
  explicitly passes `session_id`; the tool schema claims "defaults to current
  session" but does not enforce it.
- `LoopState` is a process-global map keyed by prompt text only.

## [S2] Design

### Fire routing

When a task fires, inject into the task's owning session:

1. Target session = `task.createdBySessionId` when present.
2. Legacy / unmarked tasks (no `createdBySessionId`) fall back to the current
   bridge session (previous behavior) so existing durable jobs keep firing.

`injectScheduledPrompt` already accepts an explicit `sessionID`; `onFire` must
pass the target session rather than `handle.sessionID`. Sentinel expansion
(`resolveAtFireTime`) still uses the bridge's `workspaceRoot` and the
**target** session id so the cache is keyed per receiving session.

### Session stamping

- `scheduler.add` already stamps `createdBySessionId` when `input.session_id`
  is set; keep that.
- `armLoop` must accept and stamp `session_id` on the created loop task
  (same `createdBySessionId` field). The cron tool's `loop` action passes
  `sessionID` (resolved like `schedule`).

### Ownership on read/update/delete

- `CronTool` always passes `session_id: sessionID` (resolved from
  `op.session_id || ctx.sessionID`) to `get` / `delete` / `rename`, matching
  `list` / `schedule`.
- `findById` ownership check: when a session filter is supplied, a task with a
  different `createdBySessionId` is not visible. A task with **no**
  `createdBySessionId` stays visible (legacy tolerance), matching the fire-time
  fallback. When no filter is supplied (internal callers), behavior is
  unchanged.
- `list` uses the same rule (hide only tasks stamped to another session) so
  legacy unmarked rows remain discoverable and cancellable.

### Desktop (mimo-desktop) alignment

EngineInstanceStore is a passive mirror: `apply()` accepts `message.*` /
`session.status` for any sessionID without requiring the session to be the
selected/active one. `engineAwareActivity` lights the sidebar spinner from
`sessionStatus[type≠idle]`. `refreshActivity` (2s) hydrates non-idle sessions;
`loadEngineSessions` (30s / window focus) rebuilds the convo list from the
engine session list. So a fire into a cold (unselected) session is intentional
and correctly attributed after this fix — the creating conversation is the one
that goes busy. Remaining desktop-side lag (a session not yet in `convos` may
take up to 30s to appear in the sidebar) is a UI-discovery gap, not a
correctness bug, and is out of scope here.

### Loop state

`armLoop` stamps the task; `LoopState` remains keyed by prompt for this
iteration (keepalive and max-age). Full per-session LoopState isolation is out
of scope; see S3.

### Error / edge behavior

- Target session id present but the session is gone: `injectScheduledPrompt`
  already fails into the existing log path; no new recovery.
- Same-tick double-fire latch and lock ownership stay unchanged.
- Non-owner processes still only fire session-store tasks; durable file tasks
  remain lock-owner-only.

## [S3] Out of Scope

- Multi-slot CronBridge / per-session keepalive sweeps.
- Per-session `isLoading` gating (busy of one session still delays the whole
  tick).
- Re-keying `LoopState` by (session, prompt).
- Migrating or deleting legacy unmarked durable tasks.
- Desktop UI / Automations page changes.

## Tasks
- [ ] T1: Route `onFire` through `task.createdBySessionId` with fallback to bridge session — acceptance: a task stamped with session B injects into B while the bridge is mounted on A (covers: S2)
- [ ] T2: Stamp `createdBySessionId` in `armLoop` and pass `session_id` from the cron tool `loop` action — acceptance: created loop task has `createdBySessionId` equal to the calling session (covers: S2; depends: T1)
- [ ] T3: Always pass resolved `sessionID` into `get`/`delete`/`rename` in CronTool — acceptance: get/delete/rename from session A cannot act on a task stamped to session B (covers: S2; depends: T1)
- [ ] T4: Regression tests for cross-session fire routing, loop stamping, and ownership filter — acceptance: tests fail before the fix and pass after (covers: S2; depends: T1, T2, T3)
