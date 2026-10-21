---
feature: empty-turn-part-reset
status: in-progress
updated: 2026-10-20
source: Branch fix/empty-turn-part-reset
---

# Empty Turn Keeps Message Identity

## Report

## [S1] Problem

丢弃空回合时，`SessionProcessor.process` 先 `Session.removeMessage` 删掉整条 assistant 消息，再用**同一个 message ID** `updateMessage` 重建一个空壳交给 `Effect.retry`。`ctx.assistantMessage` 在 `SessionProcessor.create` 只构造一次、`Effect.retry` 包在其内部，所以重试写回的永远是同一个 ID。

引擎数据最终一致（重试成功后数据库里就是一条完整消息），但事件流上发出了 `message.removed`。按事件顺序判定的下游无法区分「删除后重建」和「已删除实体的迟到帧」——两者的序列完全相同：`message.removed` → `message.updated` → `message.part.updated`。Mimo Desktop 的中心因此把重建当作迟到帧丢弃：重试后的正文永久不出现在界面上，切换会话也补不回来（历史读取同样被删除事实挡住），只有重启换新中心才恢复。

用户可见症状：偶发地整条丢失某一轮 assistant 回复，其余消息与侧栏状态都正常，重启后恢复。触发概率取决于模型输出 think-only / empty 的频率，因此在大量用户里低频复现。

## [S2] Design

丢弃空回合改为**重置内容、保留身份**：删掉该 message 的全部 parts，保留 message 本身，然后重置 `finish` / `error` / `time.completed` 并交回 `Effect.retry`。

- 事件序列由 `message.removed` → `message.updated` → `message.part.updated` 变为 `message.part.removed` × N → `message.updated` → `message.part.updated`。
- message 身份在重试前后不变，下游不需要「重建」语义，删除事实也不再被误用成「这条消息被删了」。
- 与同文件 `Effect.tapError` 的重试清理对齐：那里本来就只 `removePart`、不动 message 身份。
- 删 parts 使用 `process` 内已读到的 `MessageV2.parts(ctx.assistantMessage.id)`（覆盖该 message 的全部 parts），而不是 `ctx.stepPartIds`（只含当前 step），避免多 step 场景残留。
- 空壳兜底不变：重试耗尽后 `isEmptyAssistantResidue` 会清理无 parts 的 assistant；重试期间由 `liveOwned` 保护不误删。

契约不变项：

- 触发条件（classification 为 think-only / invalid、`finish !== "length"`、非 json_schema、`retrySafe`、无 tool parts）保持不变。
- 重试请求携带的历史保持不变（仍不注入提醒消息）。
- 最终持久化结果不变：一条带正文的 assistant message，`assistantOnly(...).length === 1`。

## [S3] Out of Scope

- 不修改 Desktop 的删除墓碑判据。墓碑是正确的：读取与事件是两条连接、没有跨连接顺序，墓碑挡的是删除后仍迟到的旧事件。本次只消除引擎侧把「重置」表达成「删除」的语义误用。
- 不改其他 remove 调用点（revert、compaction、resume trim、cleanupEmptyResidue、dropEmptyAssistant、tapError、REST DELETE）：它们都是真删除，且删除后不会用同一身份重建。
- 不提升 `dropping empty turn` 的日志级别。

## Tasks
- [ ] T1: 回归测试锁住事件流 — acceptance: 空回合重试后，最终 assistant message 的 ID 不出现在 `message.removed` 事件中、空回合 parts 不残留在最终消息里，且该测试在当前实现上失败 (covers: S2)
- [ ] T2: 把丢弃路径改为 removePart — acceptance: T1 转绿，`invalid-output-continuation` 既有用例全部保持绿 (covers: S2; depends: T1)
- [ ] T3: 验证 — acceptance: typecheck 与受影响 session 测试套件通过，并记录每条命令结果 (covers: S2; depends: T2)
