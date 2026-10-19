import { describe, expect, test } from "bun:test"
import {
  followStickyBottom,
  isFollowingBottom,
  scheduleFollowStickyBottom,
} from "../../../src/cli/cmd/tui/util/sticky-follow"

function box(overrides: Partial<Parameters<typeof followStickyBottom>[0]> = {}) {
  const calls: number[] = []
  const scroll = {
    _hasManualScroll: false,
    isDestroyed: false,
    scrollHeight: 100,
    scrollTo: (y: number) => {
      calls.push(y)
    },
    ...overrides,
  }
  return { scroll, calls }
}

describe("isFollowingBottom", () => {
  test("treats an explicit manual scroll as not following", () => {
    expect(isFollowingBottom({ _hasManualScroll: true })).toBe(false)
  })

  test("treats sticky-edge as following", () => {
    expect(isFollowingBottom({ _hasManualScroll: false })).toBe(true)
  })

  test("treats a missing flag as following (safe snap direction)", () => {
    expect(isFollowingBottom({})).toBe(true)
    expect(isFollowingBottom(undefined)).toBe(false)
  })
})

describe("followStickyBottom", () => {
  test("snaps to the new height while following", () => {
    const { scroll, calls } = box({ scrollHeight: 240 })
    followStickyBottom(scroll as never)
    expect(calls).toEqual([240])
  })

  test("leaves a manual scroll alone", () => {
    const { scroll, calls } = box({ _hasManualScroll: true, scrollHeight: 240 })
    followStickyBottom(scroll as never)
    expect(calls).toEqual([])
  })

  test("ignores a destroyed scrollbox", () => {
    const { scroll, calls } = box({ isDestroyed: true, scrollHeight: 240 })
    followStickyBottom(scroll as never)
    expect(calls).toEqual([])
  })
})

describe("scheduleFollowStickyBottom", () => {
  test("coalesces bursts and snaps once after layout", () => {
    const timers: { cb?: () => void; n: number } = { n: 0 }
    const fakeSetTimeout = ((cb: () => void) => {
      timers.n += 1
      timers.cb = cb
      return timers.n as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    const fakeClearTimeout = (() => {
      timers.cb = undefined
    }) as typeof clearTimeout

    const { scroll, calls } = box({ scrollHeight: 320 })
    scheduleFollowStickyBottom(scroll as never, { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout })
    scheduleFollowStickyBottom(scroll as never, { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout })
    scheduleFollowStickyBottom(scroll as never, { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout })

    // Bursts must not queue one snap per part event.
    expect(timers.n).toBe(3)
    expect(calls).toEqual([])

    timers.cb?.()
    expect(calls).toEqual([320])
  })
})
