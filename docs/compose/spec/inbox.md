---
feature: inbox
status: in-progress
updated: 2026-09-26
---

# Inbox 输入队列

每个 lane `(sessionID, agentID)` 的唯一持久化输入队列。所有外部输入（用户 prompt、actor send、子任务完成通知、workflow/spawn 投递）走同一套受理、认领、结算、停止逻辑。

## 目标

1. **一个调度归属**：inbox 是 lane 的唯一输入队列与受理/认领/结算所有者。Runner 只持有执行租约。
2. **输入同构**：任何来源的输入在受理时写成接收方切片的一条 user 消息加一行 inbox 记录，不按发送方或 type 分叉行为。
3. **唤醒同构**：任何受理都递增 `input_revision`，显式 `actor.wait` 与自动等待一律以 interrupted 结束。
4. **读取聚合**：每个步骤边界认领该 lane 全部 accepted 记录，多条输入同边界一起对模型可见。
5. **可见性**：只对模型隐藏仍在排队的输入（accepted 未认领，或被其他运行认领）。
6. **停止语义**：用户停止把 accepted/claimed 记录结算为 cancelled，消息保留且对模型可见，不自动执行。
7. **回执契约稳定**：HTTP `prompt_async` 202 `{receiptId}`、`GET /session/:sessionID/receipt/:receiptId`、`session.receipt.updated` 事件由 inbox 记录提供，`PublicReceipt` 单源。

## 表结构

新迁移目录 `packages/cli/migration/<ts>_inbox_queue/`。已发布的 `20260527000100_inbox` 迁移不改。SQLite 不支持的列变更用表重建。

### `inbox`（重建）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | ULID |
| `receiver_session_id` | text NOT NULL | lane，FK session cascade |
| `receiver_actor_id` | text NOT NULL | lane，默认 `main` |
| `sender_session_id` | text | 发送方会话（agent 输入） |
| `sender_actor_id` | text | 发送方 actor |
| `type` | text NOT NULL default `'text'` | 输入类型（`text` / `actor_notification` / …） |
| `content` | text NULL | 仅旧格式行；新行不存正文 |
| `message_id` | text | 受理时写入的 user 消息 ID |
| `state` | text NOT NULL | `accepted` \| `claimed` \| `settled` \| `cancelled` \| `rejected` |
| `epoch` | integer NOT NULL | 受理时的会话 epoch |
| `run_id` | integer | 认领运行 ID |
| `claim_frontier` | text | 认领前沿（MessageID 序） |
| `consumed` | integer NOT NULL default 0 | 是否已被模型读入 |
| `outcome` | text | `success` \| `assistant_error` \| `interrupted` \| `never_ran` |
| `delivery_message_id` | text | 首次读入该输入的 assistant 消息 |
| `error` | text | 结算错误 |
| `idempotency_key` | text NOT NULL default `''` | 会话内幂等；空串表示无键 |
| `created_at` | integer NOT NULL | |
| `time_updated` | integer NOT NULL | |

索引：`inbox_receiver_idx (receiver_session_id, receiver_actor_id, id)`、`inbox_state_idx (receiver_session_id, receiver_actor_id, state)`、`inbox_created_idx (created_at)`、部分唯一 `inbox_idem_idx (receiver_session_id, idempotency_key) WHERE idempotency_key != ''`。

### `inbox_lane_state`（新）

| 列 | 类型 | 说明 |
|---|---|---|
| `session_id` | text NOT NULL | FK session cascade |
| `agent_id` | text NOT NULL default `'main'` | |
| `consumed_frontier` | text | 已消费 MessageID 前沿 |
| `input_revision` | integer NOT NULL default 0 | 单调递增输入修订号 |
| `time_updated` | integer NOT NULL | |

主键 `(session_id, agent_id)`。

### `inbox_session_epoch`（新）

| 列 | 类型 | 说明 |
|---|---|---|
| `session_id` | text PK | FK session cascade |
| `epoch` | integer NOT NULL default 0 | 会话取消 epoch |
| `time_updated` | integer NOT NULL | |

不需要 `turn_legacy_bootstrap`：旧历史消息没有 inbox 记录，按可见性规则直接对模型可见。

## 受理（accept）

一个事务内完成：

1. 把输入写成接收方切片的一条 user 消息。agent 发来的标记 `synthetic`，并带发送方 provenance。synthetic 消息的 `agent`/`model` 在受理时按接收方确定（原 `resolveDrainSeed` 语义：standing peer 跨切片搜索；workflow 父 agent 只搜本切片，防止子 actor 通知凭空产生真实回合）。
2. 写一行 inbox 记录：`state=accepted`、`epoch`、`message_id` 指向该消息、幂等键、`type`、发送方。
3. 递增该 lane 的 `input_revision`。

事务提交后发布 `session.receipt.updated`。lane 空闲时经唯一调度路径（`schedulerRef.kick`）启动执行。

跨会话投递与发送前接收方存在性检查（`InboxReceiverNotFound`）保留。inbox 不再存正文；`send` 的 `wake`/`isWakeCancelled`/`wakeEpoch` 参数由 `AdmissionGuard`（`isCancelled`/`expectedEpoch`）取代。`promptRef.loop`、`inboxWake`、`requireClaim` 分叉与 `inboxWatermark` 合并全部删除。

## 唤醒

任何受理都递增 `input_revision`。显式 `actor.wait` 与自动等待（`waitForSubagents`）都经 `observeInput(lane, afterRevision)` 解除并返回 interrupted（有新输入到达），不取消子 actor。lane 空闲时受理即通过唯一调度路径启动执行。

## 读取

每个步骤边界认领该 lane 所有 `accepted` 记录（`claimNext`），对应消息对模型可见并记录 delivery（`delivery_message_id`，事件在事务提交后发布）。多条输入在同一边界一起读到，这就是聚合。`inbox.drain` 及其手工回滚逻辑删除。`extendClaim` 在同一运行内认领边界到达的新输入。

## 可见性

只对模型隐藏仍在排队的输入：

- inbox 记录为 `accepted`（未认领）→ 隐藏。
- 被其他运行 `claimed` → 隐藏。
- `cancelled`、`settled` → 可见。
- 没有 inbox 记录的消息（历史、压缩 replay、导入等）→ 可见。

## 停止

用户停止时，该会话所有 `accepted`/`claimed` 记录结算为 `cancelled`：`outcome` 按是否已被模型读入取 `interrupted`（`consumed=true`）或 `never_ran`。消息留在消息记录里、对模型可见，不自动执行。下次任何输入触发运行时模型会看到它们。用户 prompt 与 agent 消息同一规则。`keep-suspended`/`drop` 策略与 `suspended` 列删除。

`abortSession` 仍递增会话 epoch；epoch 低于当前值的 `accepted`/`claimed` 记录不可再被认领。

## 状态机

```text
accepted → claimed → settled   (outcome success | assistant_error)
                   → cancelled (outcome interrupted | never_ran)
accepted → cancelled | rejected
claimed  → cancelled           (停止 / epoch；consumed 区分 interrupted 与 never_ran)
```

- `settled` + `assistant_error`：回合已跑，assistant 消息带错误。
- 一个 `runId` 可认领 N 条记录；运行结束每条 claimed 记录得到终态。
- 幂等：唯一性按会话（`receiver_session_id` + `idempotency_key`）。并发 accept 同键一条插入胜出，另一条返回同一记录。GC 清理已结算记录（`settled`/`cancelled`/`rejected`），不再按创建时间一刀切。

## 对外契约

| 端点 | 契约 |
|---|---|
| `POST /session/:id/prompt_async` | **202** + `{ receiptId }` |
| `POST /session/:id/message` | 受理。busy 不 409。认领开始且客户端仍连接 → **200 stream**；否则 **202** + `{ receiptId }` 并结束响应 |
| `GET /session/:id/receipt/:receiptId` | 返回 `PublicReceipt` 投影 |
| `POST /session/:id/abort` | 响应 `{ epoch }` |
| 事件 | `session.receipt.updated` `{ receiptId, state, outcome?, messageId?, deliveryMessageId?, epoch }` |

`PublicReceipt` 字段：`id`、`lane`、`state`、`intent`、`epoch`、`consumed`、`outcome?`、`messageId?`、`deliveryMessageId?`、`error?`。内部记账（`runId`、`claimFrontier`、`idempotencyKey`、`time`）不进外部契约。

intent 对所有输入给出 `messageID`，对 agent 输入附带发送方（`senderSessionID`/`senderActorID`）与 `type`。没有 wake intent。resume/shell 仍是独占入口（不写 inbox 记录），按既有语义工作。

`deliveryMessageId` 是首次读入该输入的 model-step assistant 消息，只写一次；`session.receipt.updated` 在写入时发布。OpenAPI 响应 schema 与 HTTP body 共用 `PublicReceipt` zod 单源。

## 已发布数据

用户机器上可能存在旧格式待处理 inbox 行（有 `content`、无 `message_id`）。启动时（inbox 服务初始化）把它们转为新模型：渲染 content 为一条 synthetic user 消息并写 `message_id`，`state=accepted`。只保留这一个实现。转不动的行保留并记录日志，不丢数据。

## 对外契约变化

- `PublicReceipt.intent`：去掉 `wake`；所有输入给 `messageID`，agent 输入附发送方与 `type`。
- `session.receipt.updated` 字段不变。
- `prompt_async` 202、GET receipt 不变。
- resume/shell 独占入口不变。

## 非目标

- 在飞的 provider 请求中注入 token。
- 多进程 lane 归属。
- 重写 actor spawn/send 协议。
- resume/shell 的持久化调度（继续走独占租约）。
