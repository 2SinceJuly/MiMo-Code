---
feature: lossless-session-db
status: delivered
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

Turn-end prune only ran for users who set `compaction.prune: true`. For them, a main session resumed after its prompt cache expired now keeps its old tool outputs and reasoning verbatim inside the current window until the next boundary, so usage crosses the checkpoint thresholds and `Overflow.usable` sooner and the existing checkpoint writer and rebuild run earlier. With the default configuration nothing changes at turn end. Subagents are unaffected (turn-end prune only read main-agent messages). Removing the rebuild-time microcompact sends tool outputs after a rebuild boundary in full whenever their message stays in the request: messages that `collapseCheckpointTail` keeps (user-role messages, and messages outside `(coveredUpTo, digestUpTo]`). The first request after such a rebuild can therefore be larger than before. No trigger, threshold or ratio changes.

### S2.5 Testing boundary

- Real sessions on the scripted test provider; no mocked services.
- A main session with the legacy `compaction.prune: true` opt-in, driven past the old prune conditions (cache cold, usage in the former level-2 band, large tool outputs older than two turns), keeps every `PartTable.data` identical to what the tool returned, and reasoning parts unchanged.
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

- [x] T1: Remove turn-end prune, `stripNonEssential`, their interface members and the `prompt.ts` call site — acceptance: a regression test drives a main session whose config carries the legacy `compaction.prune: true` past the former prune conditions, fails on the base commit, and after the change asserts every tool part's stored output and every reasoning part equals what was originally stored and that the session still reaches the existing checkpoint threshold when usage crosses it (covers: S2.1, S2.2, S2.4, S2.5)
- [x] T2: Remove `SessionCompaction.prune`, its wrapper and interface member, and unreferenced prune constants — acceptance: `bun typecheck` passes in `packages/cli` with no remaining reference (covers: S2.2)
- [x] T3: Remove rebuild-time microcompact from `insertRebuildBoundary` — acceptance: a test inserts a rebuild boundary over a session with read/bash outputs after the watermark and asserts those parts are unchanged in the database (covers: S2.1, S2.2, S2.5)
- [x] T4: Remove `pressureLevel`, `contextPressureLevel`, `compaction.prune`, `MIMOCODE_DISABLE_PRUNE` and the flag-to-config code with docs — acceptance: a config containing `compaction.prune` loads with exactly one warning and no error; no reference to the flag or the key remains outside the warning; typecheck passes (covers: S2.2)
- [x] T5: Keep legacy `time.compacted` rows rendering — acceptance: a test with a pre-existing row carrying `time.compacted` still renders `[Old tool result content cleared]`, and `history get` returns the stored text (covers: S2.3, S2.5; depends: T1)
