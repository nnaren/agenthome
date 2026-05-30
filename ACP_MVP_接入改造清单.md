# ACP 最小可行接入改造清单（MVP）

本文档用于在不破坏现有 CLI + Hook 流程的前提下，引入 Claude ACP 最小能力。

## 目标与边界

目标（MVP）：
- 不改动现有任务创建入口与 UI 主流程。
- 在主进程新增 ACP 适配层，优先消费 ACP 事件。
- 保留 `.agenthome_hook_events` 轮询作为兜底。

非目标（本期不做）：
- 不一次性移除旧 hook 文件机制。
- 不大规模重构任务状态模型。
- 不改动打包链路。

## MVP 成功标准

- `claude-code` 任务可通过 ACP 收到至少两类事件：
  - 需要用户输入/审批（对应 `waiting_input`）
  - 任务结束（成功/失败）
- ACP 不可用时，自动回退旧逻辑（hook 文件 + PTY 输出判定）。
- 用户侧无感知破坏：现有创建、输入、终止流程保持可用。

## 文件级改造清单

### 1) 新增 ACP 适配层（主进程）

新增文件：
- `src/main/acp/client.ts`

实现内容：
- 封装 ACP 客户端初始化、连接、断线重连、事件订阅。
- 对外暴露最小接口：
  - `startSession(taskId, payload)`
  - `sendUserInput(taskId, input)`
  - `stopSession(taskId)`
  - `onEvent(taskId, handler)`
- 统一事件模型（内部）：
  - `needs_input`
  - `task_exit`
  - `stdout`
  - `error`

要求：
- 失败不抛到 UI 层，返回可判定错误码并触发回退策略。

### 2) 主进程任务流接入 ACP（增量改造）

修改文件：
- `src/main/index.ts`

改造点：
- 在 `createTerminalTask` 中增加 feature flag 判定（例如 `AGENTHOME_ENABLE_ACP=1`）。
- 命中 `claude-code + flag` 时，优先创建 ACP 会话。
- 事件映射：
  - `needs_input` -> 任务状态 `waiting_input`
  - `task_exit` -> 任务状态 `completed`（并写入退出信息）
  - `error` -> 记录交互日志并自动降级到旧路径
- 保留现有：
  - `.agenthome_hook_events` watcher
  - `__AGENTHOME_STOP__` 的 PTY 数据判定
- 在 `kill-task` 中增加 `stopSession(taskId)` 清理。

### 3) 预加载层补充可选 ACP 通道（可最小化）

修改文件：
- `src/preload/index.ts`

改造点（最小）：
- 如 UI 暂不直接使用 ACP，可不新增 API，仅主进程内部消费。
- 若需可观测性，补充只读接口（可选）：
  - `get-task-runtime-mode(taskId)` 返回 `acp` 或 `legacy`。

### 4) 类型补充与兼容

修改文件：
- `src/shared/types.ts`

改造点：
- 新增可选字段（避免破坏现有类型）：
  - `runtimeMode?: 'legacy' | 'acp'`
  - `lastError?: string`
- 保持原 `TaskStatus` 不变，避免 UI 大面积改动。

### 5) 配置与开关

新增文件（建议）：
- `.env.example`（或在 README/CLAUDE.md 记录）

最小配置项：
- `AGENTHOME_ENABLE_ACP=0`（默认关闭）
- `AGENTHOME_ACP_ENDPOINT=...`（按实际 ACP 接入方式）
- `AGENTHOME_ACP_TIMEOUT_MS=...`

原则：
- 默认走 legacy；仅显式开启才走 ACP。

## 兼容与回退策略

- ACP 初始化失败：任务继续走 legacy PTY + hook 逻辑。
- ACP 运行中断线：记录日志，状态保持可恢复，必要时回退 legacy。
- 任一异常不得阻断任务创建与输入链路。

## 验证清单（手工）

1. 关闭 ACP 开关，创建 `claude-code` 任务：行为与当前一致。  
2. 开启 ACP，创建任务并触发“需要输入”：任务进入 `waiting_input`。  
3. 在 `waiting_input` 输入后可恢复运行。  
4. 任务结束后状态正确落到 `completed`，有退出信息。  
5. 人工模拟 ACP 不可用（错误 endpoint）：自动回退 legacy，任务仍可运行。  
6. `kill-task` 可同时清理 PTY 与 ACP 会话（如有）。  

## 实施顺序（建议 3 次提交）

1. **提交 1：基础设施**
   - 新增 `src/main/acp/client.ts`
   - 增加开关与基础日志
2. **提交 2：主流程接入**
   - `create-task` / `task-send-input` / `kill-task` 接入 ACP 分支
   - 保留并验证回退链路
3. **提交 3：类型与可观测性**
   - `src/shared/types.ts` 增加可选字段
   - （可选）预加载只读接口 + UI 轻量显示 runtimeMode

## 风险提示

- 当前任务状态语义本就存在“created 列与实际创建即 running”的偏差；ACP 接入不应扩大该偏差。
- 先保证事件映射稳定，再考虑替换旧 hook 文件机制。
- 若跨平台通知要一并处理，建议独立小任务，不与 ACP MVP 绑定上线。
