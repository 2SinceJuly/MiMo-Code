---
feature: tips-login-credential-gate
status: delivered
updated: 2026-02-14
branch: fix/tips-login-credential-gate
commits: 67fecf88..HEAD
---

# Tips /login Credential Gate

## Report

**What was built** — Home tips no longer force the `/login` tip just because the auth store is empty. The tip is shown only when no computed provider carries known credentials. A provider counts as credential-bearing when it has `key`, `source === "env"`, or a non-empty `options.apiKey`. That covers env keys, `mimocode.jsonc` API keys, and auth-store API keys through one rule. Bare membership in the computed provider list does not count — mimo is always listed and is not a credential. Keyless local-only `provider` blocks still recommend `/login` (accepted gap).

**Verification** — From `packages/cli`: `bun test test/cli/cmd/tui/tips-view.test.ts` → 11 pass / 0 fail. From worktree root: `bun run typecheck` PASS.

**Journey log** — `provider_next.authenticated` is auth-store only and missed config/env keys. Counting “providers in the list” false-positives on mimo. The gate is per-provider credential fields, not list membership or auth-store presence.
