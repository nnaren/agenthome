# CLAUDE.md

本文档是 Claude Code 在本仓库中的工作指南。

## 项目概览

AgentHome 是一个基于 Electron 的多 Agent 任务编排桌面应用，包含：
- 四列看板：`created` / `running` / `completed` / `interrupted`
- 基于 xterm.js 的实时终端输出
- 任务交互面板（可继续输入）

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

终端交互：
- `task-get-buffer`
- `task-send-input`
- `resize-pty`

项目与窗口：
- `get-project-path`
- `select-directory`
- `open-task-create-window`

## 任务生命周期（实际行为）

以 `src/main/index.ts` 当前实现为准：
1. `create-task` 创建任务时直接设为 `running`，并立即启动 PTY。
2. 检测到 `__AGENTHOME_STOP__` 后，任务切到 `waiting_input`。
3. 用户对 `waiting_input` 任务发送输入后，状态恢复为 `running`。
4. PTY 退出后，任务状态设为 `completed`，并记录 `exitCode`。
5. 手动 kill 后，任务状态设为 `interrupted`。

UI 说明：从使用视角看，`waiting_input` 通常与运行态任务一起展示/处理。

## Claude Code 集成

当 `agent: 'claude-code'` 时：
1. 主进程会写入 hooks 配置到：
   - `.claude/settings.json`
   - `.claude/settings.local.json`
2. Stop hook 会向 `.agenthome_hook_events` 写入标记。
3. 主进程轮询该事件文件，检测到标记后将任务置为 `waiting_input`。
4. 使用 `osascript` 发送 macOS 通知。

使用注意：
- Claude 任务启动时会覆盖写入上述 hooks 配置文件。
- 通知实现当前依赖 macOS；Linux/Windows 无等价实现。
- 若 hook 事件文件未被写入，则不会自动切换到 `waiting_input`。

## Agent 类型映射

- `claude-code` -> `claude`
- `flow-cli` -> `flow`
- `hermes-agent` -> `hermes`

本地环境需保证以上 CLI 在 PATH 中可执行。

## 常见排障

- `npm install` 卡在 Electron 二进制下载：
  - 检查代理、镜像与 Electron 缓存目录。
- 任务启动后秒退：
  - 检查映射 CLI（`claude` / `flow` / `hermes`）是否可执行。
- 任务未进入 `waiting_input`：
  - 检查 `.agenthome_hook_events` 是否被创建并持续追加。

## 关键文件

- `src/main/index.ts`：PTY 管理、hook watcher、IPC 入口
- `src/preload/index.ts`：安全桥接 API
- `src/renderer/App.tsx`：主界面布局与任务刷新流
- `src/renderer/components/TaskBoard.tsx`：看板分列与任务聚合
- `src/renderer/components/TaskInteractionPanel.tsx`：xterm 交互
- `src/shared/types.ts`：共享类型定义
- `electron.vite.config.ts`：main/preload/renderer 构建配置