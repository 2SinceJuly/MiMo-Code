---
feature: lossless-session-db
status: in-progress
updated: 2026-10-20
branch: feat/lossless-session-db
commits:
---

# Lossless Session DB

## Report

## [S1] Problem

References cite symbols in `packages/cli/src`.

The session database (`PartTable`) is the only copy of a conversation, but three code paths rewrite tool output in place:

- Turn-end `prune` in `session/prune.ts`: when the prompt cache is cold and context pressure is high, it soft-trims main-agent tool outputs over 4096 chars to head and tail, or sets `state.time.compacted`, and blanks reasoning and media through `stripNonEssential`.
- `SessionCompaction.prune` in `session/compaction.ts` sets `time.compacted`. It has no caller.
- Rebuild-time microcompact in `insertRebuildBoundary` (`session/checkpoint.ts`) sets `time.compacted` on read/bash/grep/edit outputs after the boundary.

A compacted output renders as `[Old tool result content cleared]` in `toModelMessages` (`session/message-v2.ts`), and `history get` (`history/service.ts`) returns the rewritten data. Anything the model or the user later needs to recover from the session (a test log, a grep hit, a reasoning step) may already be gone, so neither `history get` nor a script reading the database can serve as a source of truth.

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

Without prune, a main session resumed after its prompt cache expired keeps its old tool outputs verbatim inside the current window until the next boundary. Usage therefore crosses the checkpoint thresholds and `Overflow.usable` sooner, and the existing checkpoint writer and rebuild run earlier. Subagents are unaffected (turn-end prune only read main-agent messages). No trigger, threshold or ratio changes.

### S2.5 Testing boundary

- Real sessions on the scripted test provider; no mocked services.
- A main session driven past the old prune conditions (cache cold, usage above the former level-1 band, large tool outputs older than two turns) keeps every `PartTable.data` identical to what the tool returned, and reasoning parts unchanged.
- A checkpoint rebuild leaves outputs after the boundary identical in the database.
- `history get` on any tool part returns the full stored output through paging.
- A legacy row with `time.compacted` still renders the cleared marker.
- Existing tests that assert prune or microcompact behavior are deleted together with the code they test; tests of `fireCheckpoints` and thresholds keep passing unchanged.

## [S3] Out of Scope

- Changing checkpoint thresholds, the overflow trigger ratio, or adding new window-switch triggers.
- Changing summary compaction or the checkpoint writer.
- Migrating or restoring outputs that were already cleared before this change.
- History index kinds (`history/extract.ts`).

## Tasks

- [ ] T1: Remove turn-end prune, `stripNonEssential`, their interface members and the `prompt.ts` call site — acceptance: a regression test drives a main session past the former prune conditions and asserts every tool part's stored output and every reasoning part equals what was originally stored, and that the session still reaches the existing checkpoint threshold when usage crosses it (covers: S2.1, S2.2, S2.4, S2.5)
- [ ] T2: Remove `SessionCompaction.prune`, its wrapper and interface member, and unreferenced prune constants — acceptance: `bun typecheck` passes in `packages/cli` with no remaining reference (covers: S2.2)
- [ ] T3: Remove rebuild-time microcompact from `insertRebuildBoundary` — acceptance: a test inserts a rebuild boundary over a session with read/bash outputs after the watermark and asserts those parts are unchanged in the database (covers: S2.1, S2.2, S2.5)
- [ ] T4: Remove `pressureLevel`, `contextPressureLevel`, `compaction.prune`, `MIMOCODE_DISABLE_PRUNE` and the flag-to-config code with docs — acceptance: a config containing `compaction.prune` loads with exactly one warning and no error; no reference to the flag or the key remains outside the warning; typecheck passes (covers: S2.2)
- [ ] T5: Keep legacy `time.compacted` rows rendering — acceptance: a test with a pre-existing row carrying `time.compacted` still renders `[Old tool result content cleared]`, and `history get` returns the stored text (covers: S2.3, S2.5; depends: T1)
