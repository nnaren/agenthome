# CLAUDE.md

本文档是 Claude Code 在本仓库中的工作指南。

## 项目概览

AgentHome 是一个基于 Electron 的多 Agent 任务编排桌面应用，包含：
- 四列看板：`created` / `running` / `completed` / `interrupted`
- 基于 xterm.js 的实时终端输出（传统模式）
- **任务交互面板**（可继续输入，支持 ACP 流式会话）
- **ACP（Agent Client Protocol）协议支持** — 与 Claude Code 的原生流式交互

运行时注意：当前主进程逻辑中，任务创建后会直接进入 `running`。`created` 状态目前更多是类型与看板列定义保留，不是默认入口状态。

## 常用命令

```bash
npm run dev            # Electron + Renderer 热更新开发
npm run build          # 生产构建
npm run package        # 构建并打包当前平台
npm run package:win    # 构建并打包 Windows
npm run package:linux  # 构建并打包 Linux
npm run lint           # 对 src 运行 ESLint
```

## 架构说明

### 多进程结构

- **Main 进程**（`src/main/index.ts`）
  - 任务编排与 PTY 生命周期管理（`node-pty`）
  - Claude stop hook 事件监听/轮询
  - IPC 与窗口管理
- **Preload**（`src/preload/index.ts`）
  - 通过 `contextBridge` 暴露类型化 `electronAPI`
- **Renderer**（`src/renderer/`）
  - React UI：工具栏、看板、任务卡片、交互面板、任务创建窗口
- **Shared**（`src/shared/types.ts`）
  - 公共类型：`Task`、`TaskStatus`、`AgentType` 等

### 当前 IPC 通道

任务与查询：
- `get-tasks`
- `create-task`
- `update-task-status`
- `kill-task`

终端交互（传统 PTY 模式）：
- `task-get-buffer`
- `task-send-input`
- `resize-pty`

ACP 协议（`src/main/acp/`）：
- `acp-send-and-stream`：发送 prompt 并获取流式响应
- `acp-cancel`：取消当前 ACP 会话
- `acp-cancel-by-task`：按任务 ID 取消
- `acp-respond-permission`：响应工具权限请求
- `get-acp-task-busy`：查询任务是否忙碌
- `get-task-runtime-mode`：获取任务运行时模式（`acp` / `legacy`）

聊天历史：
- `get-chat-history`
- `set-chat-history`

项目与窗口：
- `get-project-path`
- `select-directory`
- `open-task-create-window`

WebSocket 推送（`webContents.send`）：
- `pty-data`：PTY 数据推送
- `acp-session-update`：ACP 会话事件推送

## 任务生命周期（实际行为）

### 传统 PTY 模式
1. `create-task` 创建任务时直接设为 `running`，并立即启动 PTY。
2. 检测到 `__AGENTHOME_STOP__` 后，任务切到 `waiting_input`。
3. 用户对 `waiting_input` 任务发送输入后，状态恢复为 `running`。
4. PTY 退出后，任务状态设为 `completed`，并记录 `exitCode`。
5. 手动 kill 后，任务状态设为 `interrupted`。

### ACP 模式（`claude-code` + `AGENTHOME_ENABLE_ACP=1`）
1. 任务启动时尝试连接 ACP 服务端点。
2. 创建 ACP session，发送初始 prompt。
3. 流式接收 `sessionUpdate`（消息块/思考块）、`toolCall`、`toolCallUpdate` 事件。
4. `permissionRequest` 事件时任务切到 `waiting_input`，等待 UI 审批。
5. `sessionDone` 后任务切到 `waiting_input`，可继续输入。
6. `sessionError` 时任务保持 `waiting_input`，记录错误信息。

### 权限自动批准
- 默认 `AGENTHOME_ACP_AUTO_APPROVE` 非 `0` 时自动批准权限。
- 可通过 `AGENTHOME_ACP_AUTO_APPROVE=0` 改为 UI 手动确认。

UI 说明：从使用视角看，`waiting_input` 通常与运行态任务一起展示/处理。

## Claude Code 集成

### 传统模式（Hook 机制）

当 `agent: 'claude-code'` 且未开启 ACP 时：
1. 主进程会写入 hooks 配置到 `.claude/settings.json`。
2. Stop hook 会向 `.agenthome_hook_events` 写入标记。
3. 主进程轮询该事件文件，检测到标记后将任务置为 `waiting_input`。
4. 使用 `osascript` 发送 macOS 通知。

使用注意：
- Claude 任务启动时会覆盖写入 `.claude/settings.json`。
- 若本地仍存在旧的 `.claude/settings.local.json` 且含 Stop 钩子，Claude Code 可能合并执行导致重复通知；可删除其中重复的 Stop 配置。
- 通知实现当前依赖 macOS；Linux/Windows 无等价实现。
- 若 hook 事件文件未被写入，则不会自动切换到 `waiting_input`。

### ACP 模式（`AGENTHOME_ENABLE_ACP=1`）

`claude-code` 与 `hermes-agent` 支持 ACP（Hermes **默认**走 ACP，Claude 需 `AGENTHOME_ENABLE_ACP=1`）：

- 流式接收思考过程（`agent_thought_chunk`）
- 流式接收消息内容（`agent_message_chunk`）
- 工具调用通知（`tool_call`、`tool_call_update`）
- 权限请求（`requestPermission`）

**Claude Code** 默认命令：`npx @agentclientprotocol/claude-agent-acp --acp`  
**Hermes** 默认命令：`hermes acp --accept-hooks`

**会话持久化（两层）：**

| 层 | 存储 | 作用 |
|---|---|---|
| AgentHome 任务 | `~/.agenthome/sessions/tasks.jsonl` 中的 `acpSessionId` | 应用重启后 attach 到 agent 会话 |
| AgentHome UI | `~/.agenthome/sessions/chats/{taskId}.jsonl` | 聊天面板展示历史 |
| 系统日志 | `~/.agenthome/logs/system_log_{sessionId}_{yyyy-mm-dd-HH-mm-ss-SSS}.log` | 按 session 追加；无 ACP id 时 sessionId 为 `pending-{taskId}` |
| Hermes agent | `~/.hermes/state.db`（SessionDB） | Hermes 侧对话上下文 |

恢复流程：应用重启后加载 `acpSessionId` + chat JSONL；打开任务面板时 `acp-resume-session` → `session/resume`（失败则 `session/load`）；attach 期间抑制历史重放，避免与 UI 聊天重复。

环境变量：
- `AGENTHOME_ENABLE_ACP=1`：开启 Claude Code 的 ACP（Hermes 默认已开启）
- `AGENTHOME_ENABLE_ACP=0`：全局禁用 ACP
- `AGENTHOME_ACP_AGENT_COMMAND`：覆盖 Claude ACP 命令（兼容旧名）
- `AGENTHOME_ACP_CLAUDE_COMMAND` / `AGENTHOME_ACP_HERMES_COMMAND`：分别覆盖各 agent 命令
- `AGENTHOME_ACP_AUTO_APPROVE=0`：禁用自动批准权限
- `AGENTHOME_ACP_ENDPOINT`：仅作 UI 展示，不参与连接

## Agent 类型映射

- `claude-code` -> `claude`
- `flow-cli` -> `flow`
- `hermes-agent` -> `hermes chat --accept-hooks`（legacy 回退；ACP 模式用 `hermes acp --accept-hooks`）

本地环境需保证以上 CLI 在 PATH 中可执行。

## 常见排障

- `npm install` 卡在 Electron 二进制下载：
  - 检查代理、镜像与 Electron 缓存目录。
- 任务启动后秒退：
  - 检查映射 CLI（`claude` / `flow` / `hermes`）是否可执行。
- 任务未进入 `waiting_input`（传统模式）：
  - 检查 `.agenthome_hook_events` 是否被创建并持续追加。
- ACP 模式未启用：
  - 需设置 `AGENTHOME_ENABLE_ACP=1` 环境变量。
- Hermes ACP 恢复失败：
  - 确认 `hermes acp --check` 通过；会话是否仍在 `~/.hermes/state.db`。
  - AgentHome UI 聊天历史独立于 Hermes session，恢复 agent 上下文需 `acpSessionId` 有效。
- Hermes / Claude ACP 启动失败（非缺 npm 库）：
  - AgentHome 已依赖 `@agentclientprotocol/sdk`（客户端）；Hermes 的 ACP 服务在 Hermes 自己的 Python venv 里，无需在 AgentHome 再装 Hermes 包。
  - Electron 子进程 PATH 可能不含 `~/.local/bin`、nvm；主进程会自动补齐 PATH 并将 `hermes`/`npx` 解析为绝对路径。
  - 系统日志应出现 `[system] trying ACP: /path/to/hermes acp ...`；若回退 legacy，查看 `ACP unavailable` 后的 stderr 详情。
  - Hermes 需已配置 provider（`hermes auth` 或 `~/.hermes/.env`）；initialize 后会尝试 `authenticate` 使用 runtime 凭证。
- ACP 权限请求未弹出：
  - 检查是否为 `AGENTHOME_ACP_AUTO_APPROVE=0`，需手动批准。
- ACP session 错误：
  - 查看交互面板系统日志中的 `[acp] session error` 信息。
  - 检查 ACP 服务端点是否可达。

## 关键文件

### Main 进程
- `src/main/index.ts`：PTY 管理、hook watcher、IPC 入口
- `src/main/acp/AcpRuntimeRegistry.ts`：ACP 运行时注册表
- `src/main/acp/AcpTaskRuntime.ts`：ACP 任务运行时
- `src/main/acp/AcpClientBridge.ts`：ACP 客户端桥接
- `src/main/acp/AcpConnectionManager.ts`：ACP 连接管理
- `src/main/acp/AcpAgentManager.ts`：ACP Agent 管理
- `src/main/acp/client.ts`：ACP 客户端包装
- `src/main/acp/types.ts`：ACP 类型定义
- `src/main/acp/ndJsonStream.ts`：NDJSON 流解析

### Preload
- `src/preload/index.ts`：安全桥接 API

### Renderer
- `src/renderer/App.tsx`：主界面布局与任务刷新流
- `src/renderer/components/TaskBoard.tsx`：看板分列与任务聚合
- `src/renderer/components/TaskInteractionPanel.tsx`：交互面板（聊天+ACP）
- `src/renderer/components/TaskCard.tsx`：任务卡片
- `src/renderer/components/TaskCreateWindow.tsx`：任务创建窗口
- `src/renderer/components/ThoughtFold.tsx`：思考过程折叠组件
- `src/renderer/components/ToolCallCard.tsx`：工具调用卡片
- `src/renderer/components/AssistantMessageBody.tsx`：助手消息体渲染
- `src/renderer/utils/thinkStream.ts`：思考流处理
- `src/renderer/utils/streamText.ts`：流文本处理
- `src/renderer/utils/messageMarkdown.ts`：Markdown 渲染
- `src/renderer/utils/toolCallDisplay.ts`：工具调用展示

### Shared
- `src/shared/types.ts`：共享类型定义
- `src/shared/acp.ts`：ACP 事件类型
- `src/shared/chat.ts`：聊天消息类型

### 配置
- `electron.vite.config.ts`：main/preload/renderer 构建配置