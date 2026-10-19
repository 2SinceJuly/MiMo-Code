import { describe, expect, test } from "bun:test"
import {
  hasPriorFinalAssistant,
  shouldShowAssistantFooter,
} from "../../../src/cli/cmd/tui/util/assistant-footer"

const base = {
  recovering: false,
  aborted: false,
  finish: undefined as string | undefined,
  isLast: true,
  hasPriorFinal: false,
}

const assistant = (input: {
  id: string
  parentID: string
  finish?: string
  error?: { name?: string }
}) => ({ role: "assistant", ...input })

describe("shouldShowAssistantFooter", () => {
  test("shows for a recovering row even when it is not last", () => {
    expect(shouldShowAssistantFooter({ ...base, recovering: true, isLast: false, finish: "tool-calls" })).toBe(true)
  })

  test("shows for an aborted row", () => {
    expect(shouldShowAssistantFooter({ ...base, aborted: true, isLast: false, finish: "tool-calls" })).toBe(true)
  })

  test("shows for a final (stop) row even when a later tool-calls row is last", () => {
    expect(shouldShowAssistantFooter({ ...base, finish: "stop", isLast: false, hasPriorFinal: false })).toBe(true)
  })

  test("hides a non-last mid-loop row that is not final", () => {
    expect(shouldShowAssistantFooter({ ...base, finish: "tool-calls", isLast: false })).toBe(false)
  })

  test("shows the live last row while streaming (finish undefined)", () => {
    expect(shouldShowAssistantFooter({ ...base, finish: undefined, isLast: true })).toBe(true)
  })

  test("keeps the last row mounted after mid-loop finish=tool-calls", () => {
    expect(shouldShowAssistantFooter({ ...base, finish: "tool-calls", isLast: true, hasPriorFinal: false })).toBe(true)
  })

  test("hides a trailing tool-calls row that follows an already-final turn", () => {
    expect(shouldShowAssistantFooter({ ...base, finish: "tool-calls", isLast: true, hasPriorFinal: true })).toBe(false)
  })

  test("shows the last row for a non-tool-calls, non-final finish (length, cancelled, …)", () => {
    expect(shouldShowAssistantFooter({ ...base, finish: "length", isLast: true })).toBe(true)
  })
})

describe("hasPriorFinalAssistant", () => {
  test("ignores settled rows from earlier turns", () => {
    // Turn 1 closed with stop. Turn 2 is mid-loop on tool-calls — that live last
    // row must stay mounted or the footer hole reappears on turn 2+.
    const messages = [
      assistant({ id: "m1", parentID: "u1", finish: "stop" }),
      assistant({ id: "m2", parentID: "u2", finish: "tool-calls" }),
    ]
    expect(hasPriorFinalAssistant(messages, { id: "m2", parentID: "u2" })).toBe(false)
  })

  test("sees a settled row inside the same turn", () => {
    const messages = [
      assistant({ id: "m1", parentID: "u1", finish: "stop" }),
      assistant({ id: "m2", parentID: "u1", finish: "tool-calls" }),
    ]
    expect(hasPriorFinalAssistant(messages, { id: "m2", parentID: "u1" })).toBe(true)
  })

  test("treats a prior aborted row as owning the turn footer", () => {
    const messages = [
      assistant({ id: "m1", parentID: "u1", error: { name: "MessageAbortedError" } }),
      assistant({ id: "m2", parentID: "u1", finish: "tool-calls" }),
    ]
    expect(hasPriorFinalAssistant(messages, { id: "m2", parentID: "u1" })).toBe(true)
  })

  test("ignores later and non-assistant rows", () => {
    const messages = [
      { role: "user", id: "m0", parentID: "u1" },
      assistant({ id: "m3", parentID: "u1", finish: "stop" }),
      assistant({ id: "m1", parentID: "u1", finish: "tool-calls" }),
    ]
    expect(hasPriorFinalAssistant(messages, { id: "m1", parentID: "u1" })).toBe(false)
  })
})
