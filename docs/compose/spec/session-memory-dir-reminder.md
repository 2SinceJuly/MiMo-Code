---
feature: session-memory-dir-reminder
status: in-progress
updated: 2026-09-27
branch: feat/remove-recall-reminder
commits:
---

# Session Memory Directory Reminder

## Report

## [S1] Problem

Every runLoop turn persisted a recall reminder ("This session has memory at <dir>/. Recall content not in your context with: …") on the latest user message. Its tool hints and closing "Don't ask the user…" line duplicate the `# Memory system` block that `buildMemoryInstructions` already puts in the system prompt, and since the persist-once change every user message keeps its own permanent copy, so long sessions accumulate one copy per message.

The only fact the reminder carried that the system prompt lacks is the real session memory directory. The system prompt writes the session segment as the literal `current_session_id`, which no code resolves, so `<data>/memory/sessions/current_session_id/notes.md` is a nonexistent path.

The system prompt deliberately carries no session id (PR #2258): it stays byte-identical across sessions so the provider prefix cache is shared between sessions.

## [S2] Design

### Recall reminder removed

`recallHintLines`, `RECALL_REMINDER_MARKER`, `buildRecallReminderText`, the runLoop injection block and `SessionCheckpoint.hasMemoryOrTasks` (its only caller) are deleted. `hasSyntheticReminder`, `ensurePersistedUserSynthetic`, the loop-streak reminder and the compose reminder are unchanged. Recall reminder parts already persisted in old sessions stay as they are; no data migration.

### System prompt stays session-agnostic

`buildMemoryInstructions(projectID, memoryRoot)` writes the session directory as `<memoryRoot>/sessions/<session_id>` (notes.md, checkpoint.md, tasks/<id>/progress.md) and adds one sentence: `<session_id>` stands for the current session, its real directory is given in a system reminder in the conversation history, and tool calls use that real path. The block contains no real session id, so it remains byte-identical across sessions.

### Session memory directory reminder: once per context window

Exported from `session/prompt.ts`:

- `SESSION_MEMORY_DIR_MARKER = "Current session memory directory:"`
- `buildSessionMemoryDirReminderText(dir)` →
  `<system-reminder>\nCurrent session memory directory: <dir>/ — the real path of \`<session_id>\` in the Memory system instructions.\n</system-reminder>`
- `sessionMemoryDirReminderTarget({ msgs, sessionID, dir })` → the user message to receive the reminder, or `undefined`:
  1. If any visible user message has a non-ignored synthetic text part containing `` `${SESSION_MEMORY_DIR_MARKER} ${dir}/` ``, return `undefined`. Only this session's own reminder counts; the rebuild boundary's `File: <dir>/checkpoint.md` line, legacy recall parts and a parent's reminder in copied fork history do not.
  2. A user message is *answered* when an assistant message has `parentID === message.id` and is not a compaction summary (`summary: true`). An answered message was sent without the reminder, and rewriting sent history would invalidate the cached prefix.
  3. Return the first visible user message whose `info.sessionID === sessionID` if it is unanswered; otherwise the last visible user message if it is unanswered; otherwise `undefined`.

`msgs` is the runLoop history from `MessageV2.filterCompactedEffect`, which starts at the latest checkpoint/compaction boundary. The first own user message is the session's first message before any rebuild and the boundary user message after each rebuild (unanswered until the first request after the boundary), so normally the reminder sits at the head of each context window. Fork copies and sessions that predate the reminder have an answered first message; they receive it on the next new user message. `contextFrom` parent messages carry the parent's sessionID and are skipped. One copy per context window, attached before the first request that contains the target message.

runLoop calls it each step where the recall block used to be, only when `actorRegistry.servesCheckpoint(sessionID, lastUser.agentID)` is true (the same actors that receive the `# Memory system` block), with `dir = metaDir(sessionID)`, and persists via `ensurePersistedUserSynthetic` using marker `` `${SESSION_MEMORY_DIR_MARKER} ${dir}/` ``.

### Spec update

`docs/compose/spec/synthetic-parts-persistence-cache.md` describes the recall reminder as removed and lists the session memory directory reminder as a persisted synthetic.

## [S3] Out of Scope

- Rewriting or deleting recall reminder parts already stored in old sessions.
- Translating `<session_id>` inside tools.
- The duplicated "Don't ask the user about something memory may already record." sentences inside `buildMemoryInstructions`.

## Tasks

- [ ] T1: Delete the recall reminder code, `hasMemoryOrTasks`, and the recall-only tests; move retained marker/helper tests to `test/session/synthetic-reminder.test.ts` — acceptance: no references to the removed symbols remain under `packages/cli`; retained helper tests pass (covers: S2)
- [ ] T2: `buildMemoryInstructions` uses `<session_id>` and the explanatory sentence — acceptance: llm-system-prompt test asserts `<session_id>` paths are present and neither `current_session_id` nor the real session id appears in the system prompt (covers: S2)
- [ ] T3: Add the session memory directory reminder helpers and runLoop injection — acceptance: unit tests cover rules 1–3 (checkpoint rebuild boundary naming the directory, compaction boundary with summary reply, fork copy with the parent's reminder, answered first message, contextFrom history); integration test shows a multi-step turn persists exactly one reminder with the real path on the first user message, a second user turn adds none, and every request carries it; existing tests that pin exact user parts tolerate the reminder (covers: S2; depends: T1)
- [ ] T4: Update `synthetic-parts-persistence-cache.md` to the current state — acceptance: no claim that a recall reminder is injected (covers: S2)
