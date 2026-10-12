---
feature: compaction-summary-date-policy
status: in-progress
updated: 2026-10-12
branch: fix/compaction-summary-date-policy
commits:
---

# Compaction Summary Date Policy

Continuation summaries must never assert the present calendar date as fact.
Stale "today is YYYY-MM-DD" claims survive across multi-day sessions and cause
the resumed agent to stamp documents and records with the wrong day.

## [S1] Problem

The compaction Continuation Summary is generated while a session is running,
then restored later — often on another calendar day. The summarizer sees the
turn-context clock for the compaction moment and freely writes lines such as
`今天（系统时间）：2026-10-12` or `Today is 2026-10-12` into the summary body.

After restore, the resumed instance treats that line as the current date.
Documents, logs, and planning notes then carry a date that belongs to the
compaction day rather than the day the work actually happens.

## [S2] Design

### Date policy (normative)

The Continuation Summary follows these rules:

1. **Never assert the present date.** Do not write "today is …", "current date
   is …", "today (system time): YYYY-MM-DD", or any equivalent that states what
   day it is now or will be. Those claims become false as soon as the session
   crosses midnight or resumes later.
2. **Calendar dates attach to events only.** A date may appear only when the
   conversation already carried that date for a concrete event (message
   timestamp, document revision date, user-stated deadline, release day). Keep
   the date on the event. Do not invent, convert, or normalize dates.
3. **Relative time is relative to compaction.** Write "2 days before
   compaction", "earlier in this session", "pending as of compaction". The
   summary wrapper carries a `compacted-at` timestamp so the anchor is
   well-defined. Do not translate relative time into a calendar day inside the
   summary.
4. **After resume, resolve "today" from the world.** The current date comes from
   the `date` command or the user's statement. Never infer it from the summary,
   from `compacted-at`, or from any event date inside the summary.

### Surfaces

| Surface | Change |
|---------|--------|
| `packages/cli/src/agent/prompt/compaction.txt` | Add the date policy above as mandatory summary rules. |
| `SessionCompaction.buildSummaryMessage` | Stamp `compacted-at` (ISO-8601 UTC) on the wrapper and add one restore-time reminder: dates in the summary are not "today"; resolve the current date with `date` or the user; relative times are relative to `compacted-at`. |
| Tests | Lock the policy *properties* (forbid present-date claims, require event-attached dates, require compaction-relative time, require post-resume `date`/user resolution). Do not lock a single English sentence. |

### Contracts

`buildSummaryMessage(summary, trigger, hasTail, compactedAt = new Date())`:

- Wrapper element: `<conversation-summary trigger="…" compacted-at="YYYY-MM-DDTHH:MM:SS.sssZ">`
- `compacted-at` is a true event timestamp (when the summary was written). It
  is the only absolute time the wrapper may introduce. It is not "today".
- The reminder line names the method (`date` / user), not a concrete day.

Plugin-replaced compaction prompts keep their own wording, but the shipped
default prompt and wrapper enforce the policy.

### Testing boundary

- Prompt tests import `PROMPT_COMPACTION` and assert each policy property with
  independent matchers (negative present-date claims, event-attached dates,
  compaction-relative time, post-resume resolution).
- Wrapper tests pass a fixed `compactedAt` and assert the ISO stamp, the
  restore reminder properties, and that no other calendar day is invented.
- No live LLM call is required for these assertions.

## [S3] Out of Scope

- Session title / PR-style `summary.txt` prompts.
- Checkpoint writer and memory templates (their timestamps are entry metadata,
  not "today" claims).
- Changing how the turn-context clock is injected into the live conversation.
- Rewriting summaries already stored in existing sessions.

## Tasks

- [x] T1: Add date policy to `compaction.txt` — acceptance: prompt states all four rules from S2 (covers: S2)
- [x] T2: Stamp `compacted-at` and restore reminder in `buildSummaryMessage` — acceptance: wrapper carries ISO timestamp and method-only reminder (covers: S2)
- [x] T3: Regression tests for policy properties — acceptance: tests fail if any policy rule is dropped or if the wrapper loses `compacted-at` (covers: S2)
