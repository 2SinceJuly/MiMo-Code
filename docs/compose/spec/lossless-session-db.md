---
feature: lossless-session-db
status: in-progress
updated: 2026-10-20
branch: feat/lossless-session-db
commits: 4e58a80184..3db8b9bb19
---

# Lossless Session DB

## Report

**What was built** — No code path rewrites a persisted part to shrink context any more. Turn-end prune and `stripNonEssential` are gone from `session/prune.ts` together with their call in `session/prompt.ts`; the uncalled `SessionCompaction.prune`, the rebuild-time microcompact in `insertRebuildBoundary`, `pressureLevel` / `contextPressureLevel`, `Flag.MIMOCODE_DISABLE_PRUNE` and the `compaction.prune` config key are removed. `fireCheckpoints`, the threshold functions and `resetThresholds` are unchanged.

A config that still contains `compaction.prune` loads normally: `normalizeLoadedConfig` drops the key and logs one warning, the mechanism already used for `auto_worktree`. Legacy rows that carry `time.compacted` keep rendering the cleared marker, and `history get` returns their stored text. The generated SDK type loses `compaction.prune`.

**Verification** — From `packages/cli`: `bun typecheck` PASS; `packages/sdk` `bun run typecheck` PASS. New and affected tests (`turn-end-lossless`, `rebuild-boundary-lossless`, `legacy-compacted-row`, `config`, `prune`, `checkpoint-thresholds`, `overflow`): 177 pass / 0 fail. `turn-end-lossless` and `rebuild-boundary-lossless` fail on the base commit and pass on head. Full `bun test`: 6118 pass / 79 fail / 41 skip / 2 errors; every failing file (MCP, project, worktree, cron-bridge, revert-compact, tool-fail-cascade, tool-gate-cancel, apply_patch, spawn-notification) passes when run alone, and the timing-dependent MCP failure in `prompt-effect.test.ts` reproduces with base sources — PRE-EXISTING test interference.

**Journey log**
- `compaction.prune` was opt-in on the base commit (unset meant off) and the test preload isolates XDG config, so a regression test for the old prune path must write `compaction.prune: true` into the fixture's `mimocode.json`; the first version of the T1 test omitted it and passed on base.
- Removed config keys are stripped in `normalizeLoadedConfig` because the config schema is strict.
- Proving a test fails on base: copy it into a detached worktree at the base commit with `node_modules` symlinked, run the file, then remove the worktree.
- The full `bun test` run takes about 34 minutes and shows about 79 failures from interference between test files that do not reproduce per file.

## [S1] Problem

References cite symbols in `packages/cli/src`.

The session database (`PartTable`) is the only copy of a conversation, but three code paths rewrite tool output in place:

- Turn-end `prune` in `session/prune.ts`: when `compaction.prune` is explicitly `true` (unset means off, although the docs called it "default true"), the prompt cache is cold and context pressure is high, it soft-trims main-agent tool outputs over 4096 chars to head and tail, or sets `state.time.compacted`, and blanks reasoning and media through `stripNonEssential`.
- `SessionCompaction.prune` in `session/compaction.ts` sets `time.compacted`. It has no caller.
- Rebuild-time microcompact in `insertRebuildBoundary` (`session/checkpoint.ts`) sets `time.compacted` on read/bash/grep/edit outputs after the boundary.

A compacted output renders as `[Old tool result content cleared]` in `toModelMessages` (`session/message-v2.ts`), and `history get` (`history/service.ts`) returns the rewritten data. Anything the model or the user later needs to recover from the session (a test log, a grep hit, a reasoning step) may already be gone, so neither `history get` nor a script reading the database can serve as a source of truth.

The rebuild boundary is also placed in the middle of the conversation. `insertRebuildBoundary` gives the boundary message `time.created` = the watermark message's time + 1 ms, so the tail (the messages between the writer's watermark and the newest message at insert time) sorts after the boundary. `filterCompacted` walks from the newest message back to the newest boundary, so the tail stays in every later window, and every request then filters it again with `collapseCheckpointTail` (non-user tail messages dropped, user tail messages kept live) to avoid sending it next to its `# Recent activity` digest. The digest is generated once and stored on the boundary; the per-request filter only exists because of the boundary's position.

## [S2] Design

### S2.1 Invariant

After this change no code path mutates the content of a persisted part to reduce context size. Parts are only appended or updated by their own lifecycle (streaming, tool state transitions). Context size is controlled exclusively by window boundaries (checkpoint rebuild boundaries and compaction boundaries).

### S2.2 Removals

- `session/prune.ts`: the turn-end `prune` effect, `stripNonEssential`, their `Interface` members, and the turn-end `prune.prune` call in `session/prompt.ts` with the variables that only feed it. `fireCheckpoints`, threshold resolution (`defaultThresholdsFor`, `parseThreshold`, `maxAllowedFor`, `resolveThresholds`) and `resetThresholds` stay unchanged.
- `SessionCompaction.prune`, its async wrapper, and the `prune` member of the compaction `Interface`.
- The rebuild-time microcompact block in `insertRebuildBoundary`.
- `Overflow.pressureLevel` and `Overflow.contextPressureLevel`, whose only consumer is turn-end prune.
- Config key `compaction.prune`, `Flag.MIMOCODE_DISABLE_PRUNE` and the config-loading code that writes the key from the flag, plus their documentation (including the bundled `mimocode-docs` config reference). Existing configs containing `compaction.prune` load with one warning; the value is ignored.
- Constants used only by the removed code (`PRUNE_MINIMUM`, `PRUNE_PROTECT`, `PRUNE_PROTECTED_TOOLS`, the soft-trim constants) once unreferenced.

### S2.3 Legacy data

`ToolStateCompleted.time.compacted` stays in the schema as an optional read-only field so existing rows parse. Rows that already carry it keep rendering `[Old tool result content cleared]`; no new row gets it. Consumers that read the field (the TUI check in `cli/cmd/tui/routes/session/index.tsx`, the skip in `session/instruction.ts`, and `collapseCheckpointTail` neighbours) keep working on legacy rows unchanged.

### S2.4 Behavioral consequence

Turn-end prune only ran for users who set `compaction.prune: true`. For them, a main session resumed after its prompt cache expired now keeps its old tool outputs and reasoning verbatim inside the current window until the next boundary, so usage crosses the checkpoint thresholds and `Overflow.usable` sooner and the existing checkpoint writer and rebuild run earlier. With the default configuration nothing changes at turn end. Subagents are unaffected (turn-end prune only read main-agent messages). Removing the rebuild-time microcompact does not change any request: after S2.6 the tail it used to clear is outside every window, and only the checkpoint writer reads it, in full. No trigger, threshold or ratio changes.

### S2.6 Rebuild boundary at the end of the conversation

**Placement.** `insertRebuildBoundary` creates the boundary message after the newest message of the session: `time.created` is the insert time, and the id is ascending as before. The `boundaryCreatedAt` input and the code in `rebuildFromCheckpoint` that computes it are removed. `CheckpointPart` keeps its fields: `coveredUpTo` = the writer's watermark, and `digestUpTo` = the newest message at insert time, now written whenever the tail `(coveredUpTo, digestUpTo]` is non-empty (not only when the activity digest rendered lines).

**Model view.** `filterCompacted` stops at the boundary, so no tail message enters a later window. The tail is represented only by content stored on the boundary at insert time: the `# Recent activity` digest (`renderTailDigest`, unchanged) and the `Recent user input (verbatim)` section, which already quotes the newest main-agent user messages from the database. Messages created after the boundary stay live.

**Per-request filter.** For a boundary placed this way, `collapseCheckpointTail` has nothing to remove: its range lies before the boundary, outside the window. It stays for legacy boundaries, whose message sorts before the end of its range, and is applied only to them. Detection uses only stored data: a boundary is legacy when its message's `time.created` is earlier than the `time.created` of the message `digestUpTo`.

**Reminders.** Synthetic reminders persisted once per user message (skill catalog, plan, compose and recall reminders, marker-deduplicated) lived on the newest user message, which was often a tail user message. After S2.6 the newest user message in the window is the boundary, which carries none of those markers, so the existing reminder insertion attaches them to the boundary or a later user message. No new reminder logic is added.

**Checkpoint writer input.** The writer deliberately reads full-fidelity history: `buildLLMRequestPrefix` is called without `collapseCheckpointTail` for fork capture (`llm-request-prefix.ts`). Before this change it got the tail because the tail stayed in the window. `tryStartCheckpointWriter` now builds its message list as: the window up to and including the newest boundary, then, when that boundary is not legacy and has `digestUpTo`, the boundary's tail messages `(coveredUpTo, digestUpTo]` of the same agent read from the database in stream order, then the messages after the boundary. This reproduces the list the writer saw before (boundary, tail, live messages), so `computeBoundary`, the fork:false delta and `last_checkpoint_message_id` behave as before.

**Mid-loop rebuild.** An automatic rebuild between steps of a tool loop finishes the current step before the boundary as today; the digest marks tool parts that were still pending or running as interrupted, as today.

### S2.5 Testing boundary

- Real sessions on the scripted test provider; no mocked services.
- A main session with the legacy `compaction.prune: true` opt-in, driven past the old prune conditions (cache cold, usage in the former level-2 band, large tool outputs older than two turns), keeps every `PartTable.data` identical to what the tool returned, and reasoning parts unchanged.
- A checkpoint rebuild leaves outputs after the boundary identical in the database.
- `history get` on any tool part returns the full stored output through paging.
- A legacy row with `time.compacted` still renders the cleared marker.
- Existing tests that assert prune or microcompact behavior are deleted together with the code they test; tests of `fireCheckpoints` and thresholds keep passing unchanged.
- After a rebuild in a session with a non-empty tail (assistant text, tool calls with large outputs, and a tail user message), the boundary message sorts after every tail message; the next request contains the boundary and no tail message, carries the tail user text through `Recent user input (verbatim)` and the tail tools through `# Recent activity`; a message sent after the rebuild is live in the following request.
- A legacy boundary fixture (boundary time = watermark + 1 ms) renders the same request as before, with its tail collapsed.
- A checkpoint writer started after such a rebuild receives the tail messages in full (tool outputs intact) between the boundary and the live messages.
- The skill catalog reminder that was persisted on a tail user message appears in the first request after the rebuild.

## [S3] Out of Scope

- Changing checkpoint thresholds, the overflow trigger ratio, or adding new window-switch triggers.
- Changing summary compaction, the checkpoint writer's prompt, or the format of the `# Recent activity` digest.
- Migrating or restoring outputs that were already cleared before this change.
- History index kinds (`history/extract.ts`).

## Tasks

- [x] T1: Remove turn-end prune, `stripNonEssential`, their interface members and the `prompt.ts` call site — acceptance: a regression test drives a main session whose config carries the legacy `compaction.prune: true` past the former prune conditions, fails on the base commit, and after the change asserts every tool part's stored output and every reasoning part equals what was originally stored and that the session still reaches the existing checkpoint threshold when usage crosses it (covers: S2.1, S2.2, S2.4, S2.5)
- [x] T2: Remove `SessionCompaction.prune`, its wrapper and interface member, and unreferenced prune constants — acceptance: `bun typecheck` passes in `packages/cli` with no remaining reference (covers: S2.2)
- [x] T3: Remove rebuild-time microcompact from `insertRebuildBoundary` — acceptance: a test inserts a rebuild boundary over a session with read/bash outputs after the watermark and asserts those parts are unchanged in the database (covers: S2.1, S2.2, S2.5)
- [x] T4: Remove `pressureLevel`, `contextPressureLevel`, `compaction.prune`, `MIMOCODE_DISABLE_PRUNE` and the flag-to-config code with docs — acceptance: a config containing `compaction.prune` loads with exactly one warning and no error; no reference to the flag or the key remains outside the warning; typecheck passes (covers: S2.2)
- [x] T5: Keep legacy `time.compacted` rows rendering — acceptance: a test with a pre-existing row carrying `time.compacted` still renders `[Old tool result content cleared]`, and `history get` returns the stored text (covers: S2.3, S2.5; depends: T1)
- [ ] T6: Capture a golden fixture of the request rendered after a legacy rebuild boundary (boundary time = watermark + 1 ms, collapsed tail) before changing placement — acceptance: a committed test asserts the current rendered model messages for that fixture and passes on the base of this task (covers: S2.6)
- [ ] T7: Place the rebuild boundary after the newest message, write `digestUpTo` for every non-empty tail, remove `boundaryCreatedAt`, and apply `collapseCheckpointTail` only to legacy boundaries — acceptance: the S2.5 rebuild test (boundary after every tail message; next request has no tail message, has the tail user text and tool digest; a later message is live) fails before the change and passes after; the T6 fixture still passes; the reminder test passes (covers: S2.4, S2.6; depends: T6)
- [ ] T8: Feed the checkpoint writer the boundary's tail from the database — acceptance: a writer started after a T7 rebuild receives, in order, the boundary, every tail message with its full tool output, and the live messages; it fails before the change and passes after; existing writer, fork and threshold tests pass (covers: S2.6; depends: T7)
