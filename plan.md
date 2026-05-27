# Agent 编排管理桌面应用方案

## 技术选型（与 VS Code 相同）

| 层级 | 技术 |
|------|------|
| 桌面外壳 | Electron |
| 语言 | TypeScript |
| UI 组件 | 自研 vs/base 或迁移到 React |
| 编辑器/日志 | Monaco Editor |
| 打包 | electron-builder（跨平台） |

## 核心功能

1. **Agent 管理** — 增删启停多个 Agent 进程
2. **任务编排** — 可视化编排任务流（类似 VS Code Task 系统）
3. **会话管理** — 多个 Agent 对话上下文（基于 Hermes 的会话 DB）
4. **日志/监控** — Monaco terminal 输出、状态面板
5. **设置面板** — Agent 配置、快捷键

## 目录结构

```
agenthome/
├── src/
│   ├── main/          # Electron 主进程
│   ├── renderer/      # 前端（TypeScript + Monaco）
│   ├── preload/       # 进程桥接
│   └── shared/        # 共用类型/常量
├── package.json
└── electron-builder.yml
```

## 关键依赖

```json
{
  "electron": "^28.x",
  "electron-builder": "^24.x",
  "typescript": "^5.x",
  "monaco-editor": "^0.x",
  "react": "^18.x"
}
```

---

## 页面一：Agent 任务状态

### 布局（四列看板）

从左到右依次：

| 创建任务 | 运行中任务 | 完成任务 | 中断的任务 |
|----------|------------|----------|------------|

### 功能描述

- **创建任务** — 新建任务，支持输入任务名称、描述、关联 Agent
- **运行中任务** — 正在执行的任务，实时展示进度/日志
- **完成任务** — 已成功结束的任务，展示结果摘要
- **中断的任务** — 被手动中断或异常终止的任务，支持重试

### 交互

- 拖拽任务卡片在四列之间移动（状态流转）
- 点击任务卡片展开详情（Monaco 日志窗口）
- 工具栏：新建任务、刷新、筛选

### 技术实现

- 主进程维护任务状态机，通过 IPC 与渲染层通信
- 使用 React + 自研 UI 组件
- Monaco Editor 用于日志详情展示