import { describe, expect, test } from "bun:test"
import PROMPT_COMPACTION from "../../src/agent/prompt/compaction.txt"
import { buildSummaryMessage } from "../../src/session/compaction"

// 锁定日期策略性质，不绑定某一句英文措辞：每条规则用独立的性质断言覆盖。
describe("compaction date policy", () => {
  test("prompt forbids asserting the present calendar date as fact", () => {
    expect(PROMPT_COMPACTION).toMatch(/never write/i)
    expect(PROMPT_COMPACTION).toMatch(/today is/i)
    expect(PROMPT_COMPACTION).toMatch(/current date is/i)
    expect(PROMPT_COMPACTION).toMatch(/system time/i)
    expect(PROMPT_COMPACTION).toMatch(/YYYY-MM-DD/)
    expect(PROMPT_COMPACTION).toMatch(/assert(ing|s)? the present/i)
  })

  test("prompt keeps calendar dates attached to events already in the conversation", () => {
    expect(PROMPT_COMPACTION).toMatch(/attach a calendar date only to an event/i)
    expect(PROMPT_COMPACTION).toMatch(/already carried that date/i)
    expect(PROMPT_COMPACTION).toMatch(/do not invent/i)
  })

  test("prompt expresses relative time against compaction, not as a calendar day", () => {
    expect(PROMPT_COMPACTION).toMatch(/relative to compaction/i)
    expect(PROMPT_COMPACTION).toMatch(/compacted-at/i)
    expect(PROMPT_COMPACTION).toMatch(/do not translate relative time into a calendar day/i)
  })

  test("prompt resolves post-resume current date from date or the user", () => {
    expect(PROMPT_COMPACTION).toMatch(/after resume/i)
    expect(PROMPT_COMPACTION).toMatch(/`date`/)
    expect(PROMPT_COMPACTION).toMatch(/or the user/i)
    expect(PROMPT_COMPACTION).toMatch(/never infer/i)
  })

  test("summary wrapper stamps compacted-at as the only absolute time anchor", () => {
    const compactedAt = new Date("2026-10-12T07:30:00.000Z")
    const message = buildSummaryMessage("## Goal\nShip it", "manual", false, compactedAt)
    expect(message).toContain('compacted-at="2026-10-12T07:30:00.000Z"')
    expect(message).toContain("Compacted at 2026-10-12T07:30:00.000Z (UTC)")
    // 包装器只允许出现 compacted-at 这一个日历日，禁止夹带其它日期
    const days = message.match(/\d{4}-\d{2}-\d{2}/g) ?? []
    expect(days.length).toBeGreaterThan(0)
    expect(days.every((day) => day === "2026-10-12")).toBe(true)
    expect(message).not.toMatch(/today is/i)
    expect(message).not.toMatch(/current date is/i)
  })

  test("summary wrapper reminds restore path to resolve today from date or the user", () => {
    const message = buildSummaryMessage("## Goal\nShip it", "automatic", true)
    expect(message).toMatch(/dates in the summary are not "today"/i)
    expect(message).toMatch(/`date`/)
    expect(message).toMatch(/or the user/i)
    expect(message).toMatch(/relative to this compaction timestamp/i)
    expect(message).toContain('trigger="automatic"')
    expect(message).toContain("Complete API rounds")
  })
})
