import { describe, test, expect } from "bun:test"
import {
  hasSyntheticReminder,
  buildLoopStreakReminderText,
  buildSessionMemoryDirReminderText,
  sessionMemoryDirReminderTarget,
  LOOP_STREAK_REMINDER_MARKER,
  SESSION_MEMORY_DIR_MARKER,
  COMPOSE_REMINDER_MARKER,
} from "../../src/session/prompt"
import { promoteComposeProtocolFirst } from "../../src/session/message-v2"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

function textPart(text: string, synthetic?: boolean, ignored?: boolean): MessageV2.TextPart {
  return {
    id: "p1" as PartID,
    sessionID: "ses_test" as SessionID,
    messageID: "msg_test" as MessageID,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
    ...(ignored ? { ignored: true } : {}),
  }
}

function message(
  id: string,
  sessionID: SessionID,
  role: "user" | "assistant",
  parts: MessageV2.Part[],
  extra: { parentID?: string; summary?: boolean } = {},
) {
  return { info: { id: MessageID.make(id), sessionID, role, ...extra }, parts } as unknown as MessageV2.WithParts
}

describe("synthetic reminder markers", () => {
  test("buildLoopStreakReminderText embeds the stable marker", () => {
    const text = buildLoopStreakReminderText(3)
    expect(text).toContain(LOOP_STREAK_REMINDER_MARKER)
    expect(text).toContain("Your last 3 steps")
  })

  test("markers are distinct and non-empty", () => {
    const markers = [COMPOSE_REMINDER_MARKER, LOOP_STREAK_REMINDER_MARKER, SESSION_MEMORY_DIR_MARKER]
    expect(markers.every((m) => m.length > 0)).toBe(true)
    expect(new Set(markers).size).toBe(markers.length)
  })

  test("hasSyntheticReminder matches only non-ignored synthetic text parts", () => {
    const marker = LOOP_STREAK_REMINDER_MARKER
    expect(hasSyntheticReminder([], marker)).toBe(false)
    expect(hasSyntheticReminder([textPart(`user asked about ${marker}`)], marker)).toBe(false)
    expect(hasSyntheticReminder([textPart(marker, true)], marker)).toBe(true)
    expect(hasSyntheticReminder([textPart(marker, true, true)], marker)).toBe(false)
    expect(
      hasSyntheticReminder(
        [textPart("other synthetic", true), textPart(`<system-reminder>${marker}</system-reminder>`, true)],
        marker,
      ),
    ).toBe(true)
  })

  test("promoteComposeProtocolFirst moves compose synthetic to head after DB order", () => {
    const user = textPart("do the task")
    const compose = textPart(`\n<system-reminder>\n${COMPOSE_REMINDER_MARKER}...\n`, true)
    const other = textPart("skill body", true)
    const texts = (parts: MessageV2.Part[]) => parts.flatMap((p) => (p.type === "text" ? [p.text] : []))
    expect(texts(promoteComposeProtocolFirst([user, compose, other]))).toEqual([compose.text, user.text, other.text])
    expect(texts(promoteComposeProtocolFirst([compose, user]))).toEqual([compose.text, user.text])
    expect(texts(promoteComposeProtocolFirst([user, other]))).toEqual([user.text, other.text])
  })

  test("buildLoopStreakReminderText marker dedupes via hasSyntheticReminder", () => {
    const text = buildLoopStreakReminderText(3)
    expect(hasSyntheticReminder([textPart(text, true)], LOOP_STREAK_REMINDER_MARKER)).toBe(true)
  })
})

describe("session memory directory reminder", () => {
  const sessionID = SessionID.make("ses_child")
  const parentID = SessionID.make("ses_parent")
  const dir = "/tmp/example/memory/sessions/ses_child"
  const parentDir = "/tmp/example/memory/sessions/ses_parent"

  test("text carries the marker, the real directory and the placeholder it resolves", () => {
    const text = buildSessionMemoryDirReminderText(dir)
    expect(text).toContain(`${SESSION_MEMORY_DIR_MARKER} ${dir}/`)
    expect(text).toContain("<session_id>")
    expect(text.startsWith("<system-reminder>")).toBe(true)
  })

  test("targets the first own user message of the window", () => {
    const first = message("msg_1", sessionID, "user", [textPart("hello")])
    expect(sessionMemoryDirReminderTarget({ msgs: [first], sessionID, dir })).toBe(first)
  })

  test("never rewrites a user message the model already answered", () => {
    // Sessions predating the reminder: the first message was sent without it.
    const legacy = [
      message("msg_1", sessionID, "user", [textPart("hello")]),
      message("msg_2", sessionID, "assistant", [], { parentID: "msg_1" }),
      message("msg_3", sessionID, "user", [textPart("next")]),
    ]
    expect(sessionMemoryDirReminderTarget({ msgs: legacy, sessionID, dir })).toBeUndefined()
  })

  test("after a compaction the boundary is targeted despite its summary reply", () => {
    const boundary = message("msg_5", sessionID, "user", [])
    const msgs = [
      boundary,
      message("msg_6", sessionID, "assistant", [textPart("summary")], { parentID: "msg_5", summary: true }),
      message("msg_7", sessionID, "user", [textPart("continue")]),
    ]
    expect(sessionMemoryDirReminderTarget({ msgs, sessionID, dir })).toBe(boundary)
  })

  test("skips when the window already shows the real directory", () => {
    const withReminder = [
      message("msg_1", sessionID, "user", [textPart("hi"), textPart(buildSessionMemoryDirReminderText(dir), true)]),
      message("msg_2", sessionID, "user", [textPart("again")]),
    ]
    expect(sessionMemoryDirReminderTarget({ msgs: withReminder, sessionID, dir })).toBeUndefined()

    // Recall reminders persisted by older versions already name the directory.
    const legacy = [
      message("msg_1", sessionID, "user", [
        textPart(`<system-reminder>\nThis session has memory at ${dir}/. Recall content\n</system-reminder>`, true),
      ]),
    ]
    expect(sessionMemoryDirReminderTarget({ msgs: legacy, sessionID, dir })).toBeUndefined()

    // A user typing the path is not a reminder.
    const typed = message("msg_1", sessionID, "user", [textPart(`look at ${dir}/notes.md`)])
    expect(sessionMemoryDirReminderTarget({ msgs: [typed], sessionID, dir })).toBe(typed)
  })

  test("inherited history showing another session's directory targets the newest user message", () => {
    // Fork copy: messages carry the child's sessionID but the parent's reminder.
    const forked = [
      message("msg_1", sessionID, "user", [textPart("hi"), textPart(buildSessionMemoryDirReminderText(parentDir), true)]),
      message("msg_2", sessionID, "assistant", [], { parentID: "msg_1" }),
      message("msg_3", sessionID, "user", [textPart("fork question")]),
    ]
    expect(sessionMemoryDirReminderTarget({ msgs: forked, sessionID, dir })).toBe(forked[2])
    expect(
      sessionMemoryDirReminderTarget({
        msgs: [...forked, message("msg_4", sessionID, "assistant", [], { parentID: "msg_3" })],
        sessionID,
        dir,
      }),
    ).toBeUndefined()

    // contextFrom: the parent's messages lead the window under the parent's sessionID.
    const inherited = [
      message("msg_1", parentID, "user", [textPart("hi"), textPart(buildSessionMemoryDirReminderText(parentDir), true)]),
      message("msg_9", sessionID, "user", [textPart("child task")]),
    ]
    expect(sessionMemoryDirReminderTarget({ msgs: inherited, sessionID, dir })).toBe(inherited[1])
  })

  test("contextFrom history without any reminder skips the parent's messages", () => {
    const own = message("msg_9", sessionID, "user", [textPart("child task")])
    const msgs = [message("msg_1", parentID, "user", [textPart("parent")]), own]
    expect(sessionMemoryDirReminderTarget({ msgs, sessionID, dir })).toBe(own)
  })
})
