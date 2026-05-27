# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentHome is an Electron desktop application for managing and orchestrating multiple AI agent tasks. It provides a 4-column Kanban board (创建任务/运行中/完成任务/中断的任务) for visualizing task states, with real-time terminal output via xterm.js and interaction capabilities.

## Commands

```bash
npm run dev          # Start development server with hot reload
npm run build       # Build for production
npm run package     # Build and package for current platform
npm run package:win # Build and package for Windows
npm run package:linux # Build and package for Linux
npm run lint        # Run ESLint
```

## Architecture

### Multi-Process Structure

- **Main Process** (`src/main/index.ts`): Electron main process managing terminal tasks via `node-pty`. Handles IPC handlers for task CRUD, PTY spawning, and window management.
- **Preload** (`src/preload/index.ts`): Exposes a typed `electronAPI` interface via `contextBridge` for secure renderer-to-main communication.
- **Renderer** (`src/renderer/`): React UI with components for the task board, cards, and interaction panel.
- **Shared** (`src/shared/types.ts`): Common TypeScript types for Task, TaskStatus, and Column definitions.

### IPC Communication

The renderer communicates with main via these channels:
- `get-tasks`, `create-task`, `update-task-status` - Task management
- `task-send-input`, `task-get-buffer`, `resize-pty` - Terminal interaction
- `open-task-create-window` - Secondary window management

### Task Lifecycle

Tasks transition through statuses: `created` → `running` → `completed`/`interrupted`. The `waiting_input` status is used when Claude prompts for user approval - the main process monitors `.agenthome_hook_events` files to detect stop hooks and pause tasks.

### Claude Code Integration

When `agent: 'claude-code'` is specified, the main process automatically:
1. Writes Claude hooks configuration to `.claude/settings.json` and `.claude/settings.local.json`
2. Monitors hook events file for `__AGENTHOME_STOP__` markers to detect permission prompts
3. Uses macOS `osascript` notifications for permission prompts

### Agent Types

Supported agents are mapped to CLI commands:
- `claude-code` → `claude`
- `flow-cli` → `flow`
- `hermes-agent` → `hermes`

## Key Files

- `src/main/index.ts`: Main process entry with PTY management and IPC handlers
- `src/renderer/App.tsx`: Root React component with layout (Toolbar, TaskBoard, InteractionPanel)
- `src/renderer/components/TaskBoard.tsx`: 4-column Kanban board rendering
- `src/preload/index.ts`: Preload script exposing typed electronAPI
- `electron.vite.config.ts`: Build configuration for main/preload/renderer builds