---
feature: retry-record-part
status: designed
updated: 2026-10-21
source: Branch fix/empty-output-persistent-retry
---

# Retry Record Survives Until The Turn Succeeds

## Report

## [S1] Problem

Retries are only visible through `session.status{retry}` and the `session.retry.attempt` bus event. The processor sets status back to `busy` on the retried stream's first `start` frame, before any content arrives, so the reconnect row disappears while the retried request may still produce nothing for many minutes. Status is session-wide and only the main agent writes it, so subagent and `checkpoint-writer` retries are never visible. Nothing is persisted: a refresh, session switch or restart during a retry shows a plain "processing" turn.

`MessageV2.RetryPart` is declared in the part union but no code writes it.

## [S2] Design

### S2.1 Part shape

`RetryPart` becomes the durable retry record of one assistant message:

```ts
{
  type: "retry"
  attempt: number          // latest attempt number for this assistant message
  phase: "request" | "stream"
  scope: "request" | "live-step"
  kind: RetryKind          // network | rate_limit | server | stream | unknown
  message: string          // decision.message, same text as session.status{retry}
  hostCode?: string
  next: number             // epoch ms of the next attempt
  time: { created: number; updated: number }
}
```

The unused `error: APIError` field is removed. The SDK types are regenerated; regeneration also picks up `UserMessage.task_id`, which the committed SDK was missing relative to the current schema. History indexing (`history/projection.ts`, `history/extract.ts`) and export redaction read `message` instead of the old error.

### S2.2 Writing

- Every retry notification for an assistant message upserts one retry part on that message: the processor's stream-phase `SessionRetry.policy` `set` callback, the request-ladder `onRetryStatus` callback, and the auto-resume-after-tools retry in `processor.ts`. One part per message, keyed by a part ID held in the processor context; later retries update `attempt`, `message`, `hostCode`, `next` and `time.updated` in place.
- It is written for every actor (main, subagents, `checkpoint-writer`, compaction). `session.status{retry}` and `Session.Event.RetryAttempt` keep their current behaviour for the main agent; `session.status` keeps its own session-level attempt count, while the part counts attempts of its assistant message.
- Max-mode candidate/judge retries do not write a part (they are not the user-visible step).

### S2.3 Surviving retry cleanup

- The retry part ID is never pushed to `ctx.stepPartIds`, so the `tapError` cleanup of a retry-safe failed attempt keeps it.
- The empty-turn reset (`processor.ts`, empty/think-only branch) removes every part of the message except retry parts.
- When `runLoop.dropEmptyAssistant` deletes a stale empty assistant, its retry part is carried to the next step's assistant of the same run, so the count stays visible.
- A successful retried attempt does not remove the part; it stays visible above the recovered content until the turn ends.

### S2.4 Clearing

- On every `runLoop` exit (normal final, structured-output capture, compaction stop, failure or interruption) the engine scans the actor's full message slice, ignoring compaction filtering. For each user turn whose newest assistant completed without error, every retry part on that turn's assistants is removed.
- A turn whose newest assistant has an error (failed, aborted, abandoned) or is not completed keeps its retry parts, so the failed turn still shows how often it retried next to the error.
- A turn superseded by a queued prompt is cleared on the exit of the run that handled it, because the rule looks at each user turn's own newest assistant.
- A later successful resume of the same turn clears them by the same rule.

### S2.5 Model context

`toModelMessages` never converts retry parts, and an assistant message whose parts are only structural (step markers, retry, empty text/reasoning) is skipped. A test locks this.

## [S3] Out of Scope

- Desktop rendering of the part is a Desktop change (turn-execution RUN-R7).
- `session.status{retry}` semantics, including the `start`-frame reset to `busy`, are unchanged; Desktop renders from the part instead.
- No retry part for max-mode candidate/judge scopes.

## Tasks
- [ ] T1: Reshape `RetryPart` and regenerate the SDK — acceptance: typecheck passes with the S2.1 shape and the old `error` field gone (covers: S2.1)
- [ ] T2: Write the retry part from stream and request retries for every actor — acceptance: integration test with two empty stops then text shows one retry part with `attempt` 2 and the empty-output message on the main assistant before the turn ends; a subagent run shows the same on its own assistant (covers: S2.2; depends: T1)
- [ ] T3: Keep the part across cleanup — acceptance: after the empty-turn reset and a retry-safe stream failure the part still exists and no other residue survives (covers: S2.3; depends: T2)
- [ ] T4: Clear on turn success, keep on failure/abort — acceptance: successful turn leaves no retry part; a structured-output turn and a turn superseded by a queued prompt are cleared; cancelled turn keeps it with the last attempt; bounded-exhausted turn keeps it next to the terminal error (covers: S2.4; depends: T2)
- [ ] T5: Lock model context — acceptance: a request built from a history containing retry parts contains no retry content and no message created only from them (covers: S2.5; depends: T1)
- [ ] T6: Verify — acceptance: repo typecheck and affected session/actor/server suites pass, results recorded (covers: S2; depends: T2, T3, T4, T5)
