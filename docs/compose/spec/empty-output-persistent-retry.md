---
feature: empty-output-persistent-retry
status: in-progress
updated: 2026-10-21
source: Branch fix/empty-output-persistent-retry
---

# Empty Output Retries Persistently

## Report

## [S1] Problem

When a model step ends with no usable output (empty or think-only), `SessionProcessor.process` raises `InvalidOutputError` and `SessionRetry.policy` decides the retry. `decide` classifies it as `kind: "unknown"`, so `budgetFor` applies the bounded `unknown` budget: 8 retries within a 15-minute wall-clock deadline counted from the first failure.

Upstream Anthropic streams fail this way in bursts: a request returns HTTP 200, keeps the connection open with non-content frames for many minutes, and closes without a stop event. One such attempt can hold the stream for about 1000 seconds, which alone exceeds the 15-minute deadline. The turn then ends with "empty output" after only two attempts, although the same upstream recovers a few attempts later.

## [S2] Design

`SessionRetry.decide` classifies `InvalidOutputError` as `kind: "server"`. Empty output is a provider-side failure of an accepted request, the same recovery class as an overloaded upstream, so it uses the existing `server` budget: persistent mode, no retry count and no wall-clock deadline, exponential backoff from `initialDelayMs` (default 2 s) capped at `maxDelayMs` (default 30 s) with jitter.

- The decision stays `retryable: true` with the existing message (`error.data.message`, falling back to `"Empty model output"`), so the session retry status and the Desktop reconnect row keep showing the empty-output reason.
- Termination stays with the existing invariants: user abort/cancel interrupts the retry, `replaySafe` false (tool side effects) stops replay, and max-mode candidate/judge scopes keep their own bounded budgets.
- `retry.server` in config governs empty output from now on; `retry.unknown` no longer applies to it.
- The trigger condition in `processor.ts` (think-only/invalid classification, `finish !== "length"`, not json_schema, `retrySafe`, no tool parts) and the part-reset behaviour from `empty-turn-part-reset` are unchanged.

## [S3] Out of Scope

- The SSE idle timer in `provider.ts` `wrapSSE` resets on any byte, so a stream sending only keep-alive frames is cut only by the upstream. Changing what counts as stream activity is a separate change.
- The Desktop reconnect row is cleared when the retried stream emits its `start` frame; its visibility rules are not changed here.
- `compaction.ts` writes `InvalidOutputError` directly on summary failure without the retry policy; it is unaffected.

## Tasks
- [ ] T1: Failing tests — acceptance: `retry.test.ts` asserts `decide(InvalidOutputError)` is `{ retryable: true, kind: "server" }` with a persistent budget; an integration test with a bounded `retry.unknown` budget of one retry recovers after three consecutive empty stops; a cancel test stops a run of endless empty stops with an aborted error and no further provider calls; the first two fail on the current code (covers: S2)
- [ ] T2: Classify `InvalidOutputError` as `server` in `SessionRetry.decide` and replace the bounded-exhaustion integration test — acceptance: T1 tests pass and the other `invalid-output-continuation` cases stay green (covers: S2; depends: T1)
- [ ] T3: Verify — acceptance: repo typecheck and `bun test test/session` pass, results recorded (covers: S2; depends: T2)
