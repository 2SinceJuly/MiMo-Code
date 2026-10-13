---
feature: opencode-go-session-header
status: in-progress
updated: 2026-10-12
branch: fix/opencode-session-header
commits: 
---

# OpenCode Go Session Header

## Report

## [S1] Problem

OpenCode Go (the subscription behind `https://opencode.ai/zen/go/v1`) has hard-rejected every inference request that lacks a stable per-conversation `x-opencode-session` header since 2026-09-05 (HTTP 400 `MissingSessionID`). MiMoCode is a fork of OpenCode and is listed on https://opencode.ai/docs/go/ as a known problematic client because of XiaomiMiMo/MiMo-Code#2317.

User-visible impact:

- Every `opencode-go/*` model call through CLI and MiMo Desktop fails with `Request is missing x-opencode-session and cannot be routed efficiently`.
- Title generation / summary / compaction also fail, so the failure is not limited to the main chat turn.
- Users have been working around this with `chat.headers` hooks / plugins that re-send `input.sessionID` under the second header name.

Code today (`packages/cli/src/session/llm.ts`) already computes the correct value and sends it as `x-session-affinity` on non-ephemeral calls. The same value is never sent as `x-opencode-session`. User-Agent is already product-specific (`mimocode/<version>`), which matches the Go docs requirement.

Prior PRs (#2327 closed, #2494 open-but-conflicting) target the retired `packages/opencode/` tree and only cover non-ephemeral calls. Community reports (Letta's fix, title-gen failures) show ephemeral/auxiliary requests must also carry the header.

## [S2] Design

### Header contract (OpenCode Go only)

Only requests that target **OpenCode Go** gain the extra header. Every other provider's outbound headers stay byte-identical to today.

`isOpenCodeGoTarget(model, providerOptions?)` is true when either:

1. `model.providerID` starts with `opencode-go` (covers `opencode-go`, `opencode-go-chat`), or
2. any of `model.api.url` / `model.options.baseURL|baseUrl` / **`providerOptions.baseURL|baseUrl`** contains `opencode.ai/zen/go`.

`providerOptions` is `Provider.Info.options` (the config `provider.<id>.options` map). This matters: the TUI dialog and custom configs commonly set **only** `provider.options.baseURL` to the Go gateway — that value is resolved inside `resolveSDK` and never lands on `Provider.Model`, so model-only detection misses the standard setup. `session/llm.ts` `stream()` passes `item.options` from `provider.getProvider()`.

On matching requests from `session/llm.ts` `stream()` that have a `sessionID`:

- Send `x-opencode-session: <sessionID>` — **including** `ephemeral: true` calls (title / summary / compaction).
- Keep `x-session-affinity` and `x-parent-session-id` gated on `!input.ephemeral` exactly as today (all providers).
- Do **not** invent a new identifier. Reuse the existing stable per-conversation `sessionID`.
- Do **not** send the header when `sessionID` is empty/absent.
- `User-Agent: mimocode/<version>` stays unchanged.

### Scope of the header

**Not** sent on non-Go providers. OpenCode Zen (`opencode` without a `zen/go` URL) is out of scope.

**Call sites:** `session/llm.ts` `stream()` only (covers main chat + ephemeral title via `prompt.ts`). Other AI SDK surfaces (`predict`, `goal.evaluate`, `agent.generate`, `llm-server`, `mcp/sampling`) are intentionally not wired — if those are pointed at Go without a session header, that is operator configuration, not this fix.

### Transport coverage

The header is set in the single `stream()` headers object for matching models, so it applies to every AI SDK path that `stream()` uses (OpenAI-compatible `/chat/completions`, Anthropic `/messages`, Responses).

### Explicit non-goals

- Restoring `x-opencode-client` / `x-opencode-project` (optional in the Go docs).
- Provider-ID filtering of "opencode" (#114) or Responses-only model errors (#2030).
- Changing how `sessionID` is generated.
- Adding the header to non-Go providers.
- Covering every non-`stream()` inference call site in the repo.

## [S3] Out of Scope

- Docs rebranding of leftover OpenCode names.
- Windows hooks loader path bug (`pathToFileURL`).
- OpenCode Go model catalog / pricing / auth UI.

## Tasks

- [ ] T1: Send `x-opencode-session` on OpenCode Go requests only (including ephemeral) — acceptance: unit test for `isOpenCodeGoModel`; integration shows Go non-ephemeral carries `x-opencode-session` == sessionID next to `x-session-affinity`; Go ephemeral carries `x-opencode-session` and omits `x-session-affinity`; non-Go carries neither change (`x-opencode-session` null, affinity unchanged). (covers: S2)
- [ ] T2: Regression test + typecheck/lint — acceptance: new tests fail if the header is removed or scoped wrong; `bun run typecheck` and targeted `bun test` for `session/llm*` pass. (covers: S2; depends: T1)
