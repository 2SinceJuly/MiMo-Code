import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isGPTModel, mcpToolSearchMode, usesGPTToolset } from "../../src/tool/gpt"

const codexMode = process.env.MIMOCODE_CODEX_MODE

beforeEach(() => {
  delete process.env.MIMOCODE_CODEX_MODE
})

afterEach(() => {
  if (codexMode === undefined) delete process.env.MIMOCODE_CODEX_MODE
  else process.env.MIMOCODE_CODEX_MODE = codexMode
})

describe("isGPTModel", () => {
  test("recognizes GPT versions and API aliases", () => {
    expect(isGPTModel("gpt-4o")).toBe(true)
    expect(isGPTModel("chatgpt-4o-latest")).toBe(true)
    expect(isGPTModel("gpt-5.3-codex")).toBe(true)
    expect(isGPTModel("company-alias", "gpt-5.4", "gpt-5")).toBe(true)
  })

  test("excludes non-GPT and GPT-OSS models", () => {
    expect(isGPTModel("claude-opus-4-6")).toBe(false)
    expect(isGPTModel("gpt-oss-120b")).toBe(false)
    expect(isGPTModel("company-gpt-production", "gpt-oss-120b", "gpt-oss")).toBe(false)
  })
})

describe("mcpToolSearchMode", () => {
  const auto = { type: "auto", percent: 10 } as const
  const never = { type: "never" } as const
  const always = { type: "always" } as const

  test("keeps the configured mode for non-GPT models and always defers for GPT models", () => {
    expect(mcpToolSearchMode(auto, undefined, "claude-opus-4-6")).toEqual(auto)
    expect(mcpToolSearchMode(auto, undefined, "mimo-v2.6")).toEqual(auto)
    expect(mcpToolSearchMode(auto, undefined, "mimo-v2.6-ptc")).toEqual(auto)
    expect(mcpToolSearchMode(auto, undefined, "gpt-oss-120b")).toEqual(auto)
    expect(mcpToolSearchMode(never, undefined, "claude-opus-4-6")).toEqual(never)
    expect(mcpToolSearchMode(always, undefined, "claude-opus-4-6")).toEqual(always)
    expect(mcpToolSearchMode(never, undefined, "gpt-5.2")).toEqual(always)
  })

  test("always defers for every model when process Codex mode is enabled", () => {
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(mcpToolSearchMode(never, undefined, "claude-opus-4-6")).toEqual(always)
    expect(mcpToolSearchMode(auto, undefined, "mimo-v2.6")).toEqual(always)
  })

  test("does not force deferral for GPT models when process Codex mode is disabled", () => {
    process.env.MIMOCODE_CODEX_MODE = "false"
    expect(mcpToolSearchMode(auto, undefined, "gpt-5.2")).toEqual(auto)
    expect(mcpToolSearchMode(auto, "codex", "claude-opus-4-6")).toEqual(auto)
  })

  test("allows the resolved session mode to override the process mode", () => {
    expect(mcpToolSearchMode(auto, "codex", "claude-opus-4-6")).toEqual(always)
    expect(mcpToolSearchMode(auto, "auto", "gpt-5.2")).toEqual(always)
    expect(mcpToolSearchMode(auto, "auto", "claude-opus-4-6")).toEqual(auto)
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(mcpToolSearchMode(auto, "auto", "mimo-v2.6")).toEqual(always)
    expect(mcpToolSearchMode(auto, "default", "mimo-v2.6")).toEqual(auto)
    expect(mcpToolSearchMode(auto, "default", "gpt-5.2")).toEqual(always)
  })
})

describe("usesGPTToolset", () => {
  test("uses the normal toolset for MiMo models regardless of API transport", () => {
    expect(usesGPTToolset("mimo-v2.5")).toBe(false)
    expect(usesGPTToolset("mimo-v2.5-pro")).toBe(false)
    expect(usesGPTToolset("mimo-v2.5-pro-ultraspeed")).toBe(false)
    expect(usesGPTToolset("mimo-v2-pro")).toBe(false)
    expect(usesGPTToolset("mimo-v2.6")).toBe(false)
    expect(usesGPTToolset("mimo-ptc-test")).toBe(false)
    expect(usesGPTToolset("mimo-v2.6-ptc")).toBe(false)
  })

  test("uses the GPT toolset for every non-GPT model in process Codex mode", () => {
    expect(usesGPTToolset("claude-opus-4-6")).toBe(false)
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(usesGPTToolset("claude-opus-4-6")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6-ptc")).toBe(true)
  })

  test("uses the default toolset for GPT models when process Codex mode is disabled", () => {
    process.env.MIMOCODE_CODEX_MODE = "false"
    expect(usesGPTToolset("gpt-5.2")).toBe(false)
    expect(usesGPTToolset("deployment-primary", undefined, "gpt-5.2", "gpt")).toBe(false)
    expect(usesGPTToolset("claude-opus-4-6", "codex")).toBe(false)
  })

  test("allows the resolved session mode to override the process mode", () => {
    expect(usesGPTToolset("claude-opus-4-6", "codex")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6", "codex")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6-ptc", "codex")).toBe(true)
    expect(usesGPTToolset("deployment-primary", "codex", "mimo-v2.6", "mimo")).toBe(true)
    expect(usesGPTToolset("deployment-primary", "codex", "mimo-v2.6-ptc", "mimo")).toBe(true)
    expect(usesGPTToolset("gpt-5.2", "auto")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6-ptc", "auto")).toBe(false)
    expect(usesGPTToolset("claude-opus-4-6", "auto")).toBe(false)
    process.env.MIMOCODE_CODEX_MODE = "true"
    expect(usesGPTToolset("claude-opus-4-6", "auto")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6", "auto")).toBe(true)
    expect(usesGPTToolset("mimo-v2.6-ptc", "auto")).toBe(true)
    expect(usesGPTToolset("claude-opus-4-6", "default")).toBe(false)
    expect(usesGPTToolset("mimo-v2.6", "default")).toBe(false)
    expect(usesGPTToolset("gpt-5.2", "default")).toBe(true)
  })
})
