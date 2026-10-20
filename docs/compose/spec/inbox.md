---
feature: inbox
status: in-progress
updated: 2026-10-20
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

| 列名 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | ULID |
| `receiver_session_id` | text NOT NULL | lane，FK session cascade |
| `receiver_actor_id` | text NOT NULL | lane，默认 `main` |
| `sender_session_id` | text | 发送方会话（agent 输入） |
| `sender_actor_id` | text | 发送方 actor |
| `type` | text NOT NULL default `'text'` | 输入类型 |
| `content` | text NULL | 仅旧格式行；新行不存正文 |
| `input_message_id` | text | 受理时写入的 user 消息 ID |
| `state` | text NOT NULL default `'accepted'` | `accepted` \| `claimed` \| `settled` \| `cancelled` \| `rejected` |
| `epoch` | integer NOT NULL default 0 | 受理时的会话 epoch |
| `run_id` | integer | 认领运行 ID |
| `claim_frontier` | text | 认领前沿（MessageID 序） |
| `consumed` | integer NOT NULL default 0 | 是否已被模型读入 |
| `outcome` | text | `success` \| `assistant_error` \| `interrupted` \| `never_ran` |
| `delivery_message_id` | text | 首次读入该输入的 assistant 消息 |
| `error` | text | 结算错误 |
| `idempotency_key` | text NOT NULL default `''` | 会话内幂等；空串表示无键 |
| `created_at` | integer NOT NULL | |
| `time_updated` | integer NOT NULL | |

索引：

- `inbox_receiver_idx (receiver_session_id, receiver_actor_id, id)`
- `inbox_state_idx (receiver_session_id, receiver_actor_id, state)`
- `inbox_created_idx (created_at)`
- `inbox_idem_idx` 唯一 `(receiver_session_id, idempotency_key) WHERE idempotency_key != ''`

### `inbox_lane_state`（新表）

| 列名 | 类型 | 说明 |
|---|---|---|
| `session_id` | text NOT NULL | FK session cascade |
| `agent_id` | text NOT NULL default `'main'` | |
| `consumed_frontier` | text | 已消费 MessageID 前沿 |
| `input_revision` | integer NOT NULL default 0 | 单调递增输入修订号 |
| `time_updated` | integer NOT NULL | |

主键 `(session_id, agent_id)`。

### `inbox_session_epoch`（新表）

| 列名 | 类型 | 说明 |
|---|---|---|
| `session_id` | text PK | FK session cascade |
| `epoch` | integer NOT NULL default 0 | 会话取消 epoch |
| `time_updated` | integer NOT NULL | |

`turn_legacy_bootstrap` 不再需要：旧历史消息没有 inbox 记录，按可见性规则直接对模型可见。

## 新迁移做什么

`packages/cli/migration/<ts>_inbox_queue/migration.sql`（`<ts>` 晚于已发布的最新迁移 `20261012000000_history_cjk_unigram`）：

1. 表重建 `inbox`：建 `inbox_new`（上表列）→ 把旧行拷入（`content` 保留、`input_message_id` 置 NULL、`state='accepted'`、`time_updated=created_at`）→ 丢旧表 → 改名 → 建四个索引。
2. 建 `inbox_lane_state`、`inbox_session_epoch`。
3. 不写清理 `turn_receipt` / `turn_lane_state` / `turn_session_epoch` / `turn_legacy_bootstrap` 的语句（那四个表与两个迁移目录从未发布，当从不存在，直接删掉目录即可）。

旧行转成消息不在 SQL 里做：生成 `MessageID` 与确定 synthetic 消息的 agent/model 都依赖运行时，见「已发布数据」。

## 状态机

```text
accepted → claimed → settled   (outcome success | assistant_error)
                   → cancelled (outcome interrupted | never_ran)
accepted → cancelled | rejected
claimed  → cancelled           (停止 / epoch；consumed 区分 interrupted 与 never_ran)
```

- `settled` + `assistant_error`：回合已跑，assistant 消息带错误。
- 一个 `runId` 可认领 N 条记录；认领与执行通过 `acquireUseRelease` 形成完整生命周期，退出时统一结算，覆盖已认领但尚未进入 `runLoop` 的取消。`runLoop` 共用结算处理，成功、assistant 错误与执行中断均覆盖，每条 claimed 记录得到终态。
- 幂等：唯一性按会话（`receiver_session_id` + `idempotency_key`）。并发 accept 同键一条插入胜出，另一条返回同一记录。

### 执行错误与回执归属

- 准备与执行使用不同归属：排队 prompt 在 `inbox.accept` 事务提交前没有本次消息的失败结算权；请求携带已有消息 ID 不等于保存成功。touch 先于受理；权限与 title 保持受理后的生命周期，停止时能结算已接受的输入。受理后准备失败必须按同事务 receipt 状态判定归属：accepted 才由准备方结算，错误消息保存与取消 accepted 回执在同一事务内完成；claimed 已转交 lane 执行者。`noReply`/无 controller 的直接保存路径只在 user 写入成功后记录归属，parts 写入失败仍能保存该 user 的错误结果。
- 实际 lane 执行者在领取输入后负责未处理异常：初始化在模型读取前失败时，按数据库消息创建时间与 ID 选择本次 claim 中最新的真实输入；显式旧 ID 更新保留其 SQL 创建顺序，不能用回执受理顺序或 payload 时间替代。初始化错误不产生 delivery；步骤完成准备并创建 assistant 时归实际选中的 user；之后只更新本次新建输出。不会改写历史 assistant，也不会把恢复 B 的失败挂到后来 C。模型 processor 外的插件、转换、裁剪异常保存为精确 parent 的 assistant.error，并发布消息事实与 session.error。
- 错误消息不等于输入已经读入模型。`consumed` 与 `deliveryMessageID` 只由 `recordDelivery` 写入；执行在 delivery 前失败，claimed 输入结算为 `cancelled/never_ran`，错误文本保留在回执且 prompt 等待方仍得到持久错误消息。已 delivery 的输入失败结算为 `settled/assistant_error`。结算不得从成功的 Effect Exit 推导未读输入为 consumed。
- 纯中断、停止 epoch 已改变、instance/workspace ownership 已失效、目标 session/user 已删除时，不补业务错误或复活历史。持久错误写入与 ownership、epoch、parent 校验在同一事务内；停止和 runId 条件继续保护回执结算。
- `runLoop` 仅结算业务 body 的失败；body 成功后的生命周期/清理失败不能覆盖成功输出。Resume 不写 inbox，其准入后的 beforeWork/裁剪失败由 Resume owner 结算；进入 loop 后由 loop 结算，避免重复错误。
- session 删除、ownership 移交或回执 ACK 写入失败时，执行者仍必须完成本地等待者的 Deferred（明确失败）并释放 lease；回执持久化失败不能使客户端无限等待。
- HTTP 保持 202/receipt 与 message stream 契约。同步 message 已开始 200 后发生无法持久保存的失败，明确使响应正文读取失败；异步执行外层记录异常，不再次发布无 parent 的错误事件。
- 同步 `message` 的 Hono 流显式声明 `Transfer-Encoding: chunked`。Node HTTP/1.1 adapter 对原生 Response 不再探测预读并把首读错误当作空正文完成；由持续 reader 读取，错误销毁响应传输。该头只声明本段流传输，不是业务回执字段：Bun 可按实际输出归一传输编码；代理可在自身连接上重建 framing，客户端应以请求/正文读取明确失败识别未交付结果，不依赖响应保留该头或固定 Content-Length。当前 Node adapter 使用 HTTP/1.1，直接 HTTP/2 adapter 不属于此实现边界。

## 受理（accept）

一个事务内完成：

1. 把输入写成接收方切片的一条 user 消息。agent 发来的标记 `synthetic`，消息 provenance 为 `{ source: "agent", senderSessionID?, senderActorID? }`。synthetic 消息的 `agent`/`model` 在受理时按接收方确定（`resolveDrainSeed` 语义：standing peer 跨切片搜索，无历史时使用注册 agent 与默认模型；workflow 父 agent 只搜本切片）。缺少接收方模型来源的协调切片使用 `system` agent/model 保存消息；`laneKick` 仅在接收方切片能够解析真实模型时执行，防止子 actor 通知凭空产生真实回合。
2. 写一行 inbox 记录：`state=accepted`、`epoch`、`input_message_id` 指向该消息、幂等键、`type`、发送方。
3. 递增该 lane 的 `input_revision`。

事务提交后发布 `session.receipt.updated`。lane 空闲时经唯一调度路径（`schedulerRef.kick`）启动执行。`laneKick` 在执行租约内认领输入；子 actor 的续执行先取得 `ActorExecution`，再认领待处理记录，认领为空时结束，不发送额外终止通知。spawn/hook 初始执行沿用其外层 actor 生命周期，续执行由自己的 `runTurn` 负责终止通知。

用户 prompt 与 agent 输入共用 `inbox.accept`：`sessions.persistQueuedUser` 并入其中，不再单独存在。消息上的 `queueAdmission` 标记删除，排队状态只以 inbox 记录为准。

`noReply` 的 prompt 只写入历史、不请求执行，所以不经受理：直接写成没有 inbox 记录的普通 user 消息，按可见性规则对模型可见，不递增 `input_revision`，不启动执行，也不会被之后的运行认领。

跨会话投递与发送前接收方存在性检查（`InboxReceiverNotFound`）保留。inbox 不再存正文。`send` 的 `wake` / `isWakeCancelled` / `wakeEpoch` 参数由 `AdmissionGuard`（`isCancelled` / `expectedEpoch`）取代。会话停止时发出的子 actor 终止通知照常受理，随后由停止规则结算，没有单独的受理即作废路径。

## 唤醒

任何受理都递增 `input_revision`。显式 `actor.wait` 与自动等待（`waitForSubagents`）都经 `observeInput(lane, afterRevision)` 解除并返回 interrupted（有新输入到达），不取消子 actor。lane 空闲时受理即通过唯一调度路径启动执行。

## 读取

每个步骤边界认领该 lane 的 `accepted` 记录（`claimNext`），单次最多 100 条（`MAX_CLAIM_PER_STEP`），对应消息对模型可见并记录 delivery（`delivery_message_id`，事件在事务提交后发布）。写入 `delivery_message_id` 的同一事务把 `consumed` 置为 `true`：从这一刻起输入已被模型读入，之后停止结算为 `interrupted`。多条输入在同一边界一起读到。`inbox.drain` 及其手工回滚逻辑删除。`extendClaim` 在同一运行内认领边界到达的新输入。

## 可见性

只对模型隐藏仍在排队的输入：

- inbox 记录为 `accepted`（未认领）→ 隐藏。
- 被其他运行 `claimed` → 隐藏。
- `cancelled`、`settled` → 可见。
- 没有 inbox 记录的消息（历史、压缩 replay、导入等）→ 可见。

## 停止

用户停止时，该会话所有 `accepted`/`claimed` 记录结算为 `cancelled`：`outcome` 按是否已被模型读入取 `interrupted`（`consumed=true`）或 `never_ran`（`consumed=false`）。停止操作由 `withStop` 包围：期间抑制该会话的调度与认领，输入仍正常受理；停止操作收尾复用相同结算规则处理期间收到的输入，不再次递增 epoch。消息留在消息记录里、对模型可见，不自动执行。下次任何输入触发运行时模型会看到它们。用户 prompt 与 agent 消息同一规则。`keep-suspended` / `drop` 策略与 `suspended` 列删除。

`abortSession` 仍递增会话 epoch；epoch 低于当前值的 `accepted`/`claimed` 记录不可再被认领。

## 对外契约

| 端点 | 契约 |
|---|---|
| `POST /session/:id/prompt_async` | **202** + `{ receiptId }`；无执行输入（`noReply` 或无有效内容）为 **204**，不写 Inbox 回执 |
| `POST /session/:id/message` | 受理。busy 不 409。认领开始且客户端仍连接 → **200 stream**；否则 **202** + `{ receiptId }` 并结束响应 |
| `GET /session/:id/receipt/:receiptId` | 返回 `PublicReceipt` 投影 |
| `POST /session/:id/abort` | 响应 `{ epoch }` |
| 事件 | `session.receipt.updated` `{ sessionID, receiptId, agentID, state, outcome?, inputMessageID, deliveryMessageID?, epoch }` |

`PublicReceipt` 字段：`id`、`lane`、`state`、`type`、`senderSessionID?`、`senderActorID?`、`epoch`、`consumed`、`outcome?`、`inputMessageID`、`deliveryMessageID?`、`error?`。内部记账（`runId`、`claimFrontier`、`idempotencyKey`、`time`）不进外部契约。

每条记录只承载一条输入，字段直接平铺在回执上，没有 `intent` 包装。resume 与 shell 是独占入口（C-03），不写 inbox 记录，因此不存在 resume、shell、wake 类型。

同步 `message` 流成功时返回 JSON 结果；已开始 200 后、无法持久化的失败使正文读取拒绝，不能以空正文结束成功响应。busy 路径未产生回执时为 204；空闲 `noReply` 路径返回所保存的 user 消息，不启动模型。响应断连只 detach 此请求，已受理输入的执行归 Controller/Runner。

记录只引用两条消息：

- `inputMessageID`：受理时写入的 user 消息。客户端用它把回执关联到消息。
- `deliveryMessageID`：首次读入该输入的 model-step assistant 消息，只写一次；引擎渲染上下文时用它确定输入的位置，客户端用它判断输入已被消费。写入时发布 `session.receipt.updated`。

结算（ack）只写 `state` / `outcome` / `error`，不记录任何消息 ID。OpenAPI 响应 schema 与 HTTP body 共用 `PublicReceipt` zod 单源。

## fork

fork 的目的是让新会话继承原会话的 prefix cache，所以新会话渲染出的上下文必须与原会话逐条一致。

复制消息时按原会话渲染给模型的顺序写入：先按「可见性」过滤，再按 `delivery_message_id` 把已消费的输入移到对应 delivery 消息之前，然后按这个顺序为每条消息分配递增的新 MessageID（消息 ID 是全局主键，必须换新），assistant 的 `parentID` 指向对应的新 ID。消息读取按创建时间排序、再按 ID 排序，所以复制时把每条消息的 `time.created` 取为它的原值与序列中前一条消息 `time.created` 的较大值，使创建时间沿渲染顺序不递减。仍在排队的输入（accepted 或 claimed 未消费）按受理顺序排在末尾。`messageID` 截断点按渲染顺序计算：只复制渲染序列中该消息之前的部分。

fork 不复制 inbox 记录，也不改写任何记录里的消息 ID。新会话里的消息全部是没有 inbox 记录的普通历史，按可见性规则对模型可见，存储顺序即渲染顺序。

## 已发布数据

用户机器上可能存在旧格式待处理 inbox 行（有 `content`、无 `input_message_id`）。inbox 服务启动时把它们转为新模型：用与受理相同的写消息逻辑把 `content` 渲染为一条 synthetic user 消息，写入 `input_message_id` 并清空 `content`，`state` 保持 `accepted`、`input_revision` 照增。这是唯一的转换实现；`content` 列只为这些旧行保留为可空，新行永远为空。正文为空白或渲染为空白的旧行直接结算为 `rejected`，同时清空 `content`，后续启动不再转换。

## GC

原有 7 天按 `created_at` 清理改为：已结算记录（`settled` / `cancelled` / `rejected`）在 `time_updated` 之后 7 天清理。`accepted` / `claimed` 不按年龄清理。

## 每个调用方如何改

### `packages/cli/src/actor/notification.ts`

- `makeTerminalNotifier` 改调 `inbox.accept`（原 `inbox.send`）：`content` 改为在受理时写入 user 消息，不再先落 `content` 再 drain。
- `wake` / `isWakeCancelled` / `wakeEpoch` 参数换成 `AdmissionGuard`（`isCancelled` / `expectedEpoch`）。
- `wake: false`（会话停止时的终止通知）改为照常受理：inbox 记录照写、`input_revision` 照增，随后由停止规则结算。
- 删掉 `sent.wakeSuppressed` 分支判断。

### `packages/cli/src/actor/spawn.ts`

- `cancel(..., { wake })` 的 `wake` 选项与 `notifyTerminal` 的 `wake: false` 传递链改为走 `AdmissionGuard`。
- `wakeEpoch` 捕获改为 `expectedEpoch` 语义（发送前捕获、受理时校验）。
- 删掉对 `turnQueueRef` 的直接依赖，改用 `inbox` 服务。

### `packages/cli/src/workflow/runtime.ts`

- `inbox.send` 改 `inbox.accept`；`wake: false` 同上。
- 子 agent 完成通知同样受理（写 user 消息 + inbox 记录 + 增 `input_revision`），因此会唤醒父 agent 的等待。`resolveDrainSeed` 的「workflow 父 agent 只搜本切片」语义在受理时生效，不凭空产生真实回合。

### `packages/cli/src/tool/actor.ts`

- `inboxServiceRef.current.send` 改 `accept`；返回值给 `inputMessageID` 与 `inboxID`。
- `InboxReceiverNotFound` 错误分支保留。

### `packages/cli/src/session/prompt.ts`

- `createUserMessage` → `sessions.persistQueuedUser` 与 `tq.admit` 合并为一次 `inbox.accept`（同一事务写消息 + inbox 记录 + 增 `input_revision`）。`queueAdmission` 标记由 inbox 记录取代。
- 删掉 `inbox.drain` 全部调用（约 862、4610、4735、6228 行）及 `deferInbox` 分叉；步骤边界改为 `claimNext` / `extendClaim`。
- 认领可见性过滤（约 4766–4785 行）改为按 inbox 记录状态判断：accepted 未认领或其他运行 claimed 的消息隐藏；其余可见。
- `recordDelivery` 写 `delivery_message_id`，事件在事务提交后发布。
- 运行结束结算（ack）不再传 `messageId`。
- `abortSession` 去掉 `queuedPolicy`；`cancel` 不再收 `AbortPolicy`。
- `waitForSubagents` 与显式 `actor.wait` 都用 `observeInput` 解除；任一输入唤醒。
- 删掉 `requireClaim` / `inboxWake` / `LoopInput` 相关字段与分叉（约 3536、6155、6227、7372、7546、7548 行）。

### `packages/cli/src/session/session.ts`

- `fork` 按「fork」一节改写：按渲染顺序复制消息，不复制 inbox 记录。

### 服务端路由 `packages/cli/src/server/routes/instance/session.ts`

- `prompt_async` 202 `{receiptId}` 不变。
- `GET /receipt/:receiptId` 用 `PublicReceipt` 单源。
- abort 请求体去掉 `queuedPolicy`，响应 `{ epoch }` 不变。

### 同步 `packages/cli/src/turn-queue/sync.ts` → `packages/cli/src/inbox/sync.ts`

- 表名换成 `inbox` / `inbox_lane_state` / `inbox_session_epoch`。
- 去掉 bootstrap 分量。
- `materializeHistory` 继续为导入历史写 settled 记录。

### 其它

- `packages/cli/src/effect/app-runtime.ts`、`control-plane/workspace.ts`、`sync/restore.ts`、`server/routes/instance/sync.ts`、`cli/cmd/export.ts`、`cli/cmd/import.ts`、`session/{codex,claude,opencode}-import.ts`：import 路径换成 `@/inbox`，表名同步。
- 重新生成 SDK（`./packages/sdk/script/build.ts`）。

## 要删除的代码清单

| 位置 | 内容 |
|---|---|
| `packages/cli/migration/20260920000000_turn_queue/` | 整个目录（从未发布） |
| `packages/cli/migration/20260924000000_turn_legacy_bootstrap/` | 整个目录（从未发布） |
| `packages/cli/src/turn-queue/` | 整个模块（`controller.ts`、`schema.ts`、`events.ts`、`scheduler.ts`、`sync.ts`、`turn-queue.sql.ts`、`turn-queue-ref.ts`、`index.ts`） |
| `packages/cli/src/inbox/inbox.ts` | `send` 里的 `promptRef.loop` / `inboxWake` / `requireClaim` 分叉、`wake` 意图、`inboxWatermark` 合并、`MAX_DRAIN_PER_TURN`、`drain` 及其手工回滚、`InboxArrived` 发布（`actor/events.ts` 中的定义一并删，无订阅方） |
| `packages/cli/src/turn-queue/schema.ts` | `WakeIntent`、`ResumeIntent`、`ShellIntent`（后两者从未被受理）、`isCoalescable`、`intentRank`、`AbortPolicy`、`suspended` 字段 |
| `packages/cli/src/session/session.ts` | `persistQueuedUser`（并入 `inbox.accept`）；`fork` 中复制 inbox 记录与 `idMap` 改写记录字段的整段 |
| `packages/cli/src/inbox/controller.ts` | ack 的 `messageId` 参数及其写入 `delivery_message_id` 的 `coalesce` |
| 回执投影与事件 | `intent` 包装、`messageId` 字段 |
| `packages/cli/src/session/message-v2.ts` | user 消息的 `queueAdmission` 字段 |
| `packages/cli/src/server/routes/instance/session.ts` | abort 的 `queuedPolicy` |
| `packages/cli/src/session/prompt.ts` | `requireClaim` / `inboxWake` / `deferInbox` / `inbox.drain` 调用 / `queuedPolicy` |
| `packages/cli/src/session/resume-test-hooks.ts` | `inbox.drain` 相关注释与钩子 |

## 测试点 (a)–(s)

| # | 场景 | 验收 |
|---|---|---|
| (a) | 显式 wait A 时 B 的完成通知唤醒 main | main 的 `actor.wait` 返回 interrupted；子 actor 不被终止 |
| (b) | 自动等待被任一输入解除 | `waitForSubagents` 在 prompt 或 agent 输入受理后结束并返回 interrupted |
| (c) | 同一 lane 多输入同边界读到 | prompt 与 agent 消息按受理顺序在同一步骤边界一起被认领，均对模型可见 |
| (d) | 停止后未读输入 | prompt 与通知为 `never_ran`；不自动执行；下一次运行时对模型可见 |
| (e) | 排队中输入不可见 | accepted 未认领的输入在认领前对模型隐藏 |
| (f) | 进程重启 | 待处理 inbox 记录不丢，boot 后仍可认领 |
| (g) | 旧格式 inbox 行 | 有 `content` 无 `input_message_id` 的行转为 synthetic user 消息并被引用 |
| (h) | 跨会话投递接收方不存在 | 报 `InboxReceiverNotFound` |
| (i) | workflow 父 agent 收到子 agent 通知 | 不凭空产生真实回合（`resolveDrainSeed` 切片范围回归） |
| (j) | 压缩溢出后续跑 | `test/session/turn-queue-admission.test.ts:740` 场景 |
| (k) | `deliveryMessageID` 与回执事件 | `test/server/session-prompt-busy.test.ts:356` 场景 |
| (l) | 旧格式行正文或渲染为空 | 启动转换时结算为 `rejected`，不写空消息，重复启动无额外变更 |
| (m) | GC | 已结算记录在 `time_updated` 后 7 天清理；`accepted`/`claimed` 不清理 |
| (n) | fork 继承上下文 | 原会话含插话（输入受理早于 delivery）时，fork 后新会话渲染的消息序列与原会话逐条一致（角色、内容、顺序）；新会话无 inbox 记录；按 `messageID` 截断时按渲染顺序截断 |
| (o) | `noReply` prompt | 不产生 inbox 记录；之后的 prompt 不会执行它，也不会因它多出一次模型请求；下一次运行时对模型可见 |
| (p) | 准备保存失败归属 | Inbox.accept 消息/parts 事务失败不增加 message/receipt 或污染旧 ID；直接保存 user 成功后 parts 失败产生精确 parent 错误 |
| (q) | 未处理异常早于模型 delivery | 实际 claim owner 保存错误 assistant，回执 never_ran、consumed=false、无 delivery；所有 prompt 等待方收到该持久结果 |
| (r) | 已 delivery 后执行失败 | 消费记录结算 assistant_error；错误消息与回执可观测，lane 释放且后续输入可执行 |
| (s) | Resume 与 ownership 边界 | 准入后失败归原 parent；中断、epoch/ownership 失效、目标删除不补业务错误；成功后清理失败不重写成功回答 |
