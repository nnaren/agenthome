import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import * as pty from 'node-pty'
import log from 'electron-log'
import { mkdir, readFile, writeFile } from 'fs/promises'
import type { ChatMessageRecord } from '../shared/chat'
import type { CreateTaskInput, Task } from '../shared/types'
import { AcpRuntimeRegistry } from './acp/AcpRuntimeRegistry'
import { AcpTaskBusyError } from './acp/AcpTaskRuntime'
import {
  ensureDataDir,
  loadAllChatHistories,
  loadTasksFromDisk,
  saveChatToDisk,
  saveTasksToDisk
} from './persistence/store'

log.info('AgentHome starting...')

let mainWindow: BrowserWindow | null = null
let taskCreateWindow: BrowserWindow | null = null

const tasks: Task[] = []
const ptyMap = new Map<string, pty.IPty>()
const acpSessionIdByTask = new Map<string, string>()
const interactionBuffers = new Map<string, string[]>()
const chatHistories = new Map<string, ChatMessageRecord[]>()
const stopWatchers = new Map<string, NodeJS.Timeout>()
const hookEventOffsets = new Map<string, number>()

const AGENT_COMMAND_MAP: Record<string, string> = {
  'claude-code': 'claude',
  'flow-cli': 'flow',
  'hermes-agent': 'hermes'
}

const ACP_ENABLE = process.env.AGENTHOME_ENABLE_ACP === '1'
const ACP_ENDPOINT = process.env.AGENTHOME_ACP_ENDPOINT ?? ''
/** 默认自动批准 ACP 工具权限；设 AGENTHOME_ACP_AUTO_APPROVE=0 改为 UI 手动确认 */
const ACP_AUTO_APPROVE_PERMISSION = process.env.AGENTHOME_ACP_AUTO_APPROVE !== '0'
let acpRegistry: AcpRuntimeRegistry | null = null

let persistTasksTimer: NodeJS.Timeout | null = null
const chatPersistTimers = new Map<string, NodeJS.Timeout>()
let isFlushingPersistence = false

function schedulePersistTasks(): void {
  if (persistTasksTimer) clearTimeout(persistTasksTimer)
  persistTasksTimer = setTimeout(() => {
    persistTasksTimer = null
    void saveTasksToDisk(tasks).catch((error) => {
      log.error('[persistence] save tasks failed', error)
    })
  }, 300)
}

function schedulePersistChat(taskId: string, messages: ChatMessageRecord[]): void {
  const existing = chatPersistTimers.get(taskId)
  if (existing) clearTimeout(existing)
  chatPersistTimers.set(
    taskId,
    setTimeout(() => {
      chatPersistTimers.delete(taskId)
      void saveChatToDisk(taskId, messages).catch((error) => {
        log.error(`[persistence] save chat failed for ${taskId}`, error)
      })
    }, 500)
  )
}

async function flushPersistence(): Promise<void> {
  if (persistTasksTimer) {
    clearTimeout(persistTasksTimer)
    persistTasksTimer = null
  }
  for (const [taskId, timer] of chatPersistTimers) {
    clearTimeout(timer)
    chatPersistTimers.delete(taskId)
    const messages = chatHistories.get(taskId)
    if (messages) {
      await saveChatToDisk(taskId, messages)
    }
  }
  await saveTasksToDisk(tasks)
}

async function loadPersistedState(): Promise<void> {
  await ensureDataDir()
  const loadedTasks = await loadTasksFromDisk()
  tasks.push(...loadedTasks)
  for (const task of loadedTasks) {
    interactionBuffers.set(task.id, [])
    if (task.acpSessionId) {
      acpSessionIdByTask.set(task.id, task.acpSessionId)
    }
  }
  const chats = await loadAllChatHistories()
  for (const [taskId, messages] of chats) {
    chatHistories.set(taskId, messages)
  }
  log.info(`[persistence] loaded ${loadedTasks.length} tasks, ${chats.size} chat histories`)
}

function getAcpUnavailableReason(agent: string): string {
  if (agent !== 'claude-code') return '当前任务类型不是 claude-code，默认使用终端模式'
  if (!ACP_ENABLE) return '未开启 AGENTHOME_ENABLE_ACP=1，使用终端模式'
  return 'ACP agent 协议不可用，已回退到终端模式'
}

function ensureTaskRuntimeReason(task: Task): void {
  if (task.runtimeMode === 'acp') {
    if (!task.runtimeReason) {
      task.runtimeReason = task.acpSessionId
        ? 'ACP 会话已保存，打开任务后自动恢复'
        : '已连接 ACP 会话'
    }
    return
  }
  if (!task.runtimeMode) task.runtimeMode = 'legacy'
  if (!task.runtimeReason) task.runtimeReason = getAcpUnavailableReason(task.agent)
  if (!task.runtimeEndpoint) task.runtimeEndpoint = ACP_ENDPOINT || '(未配置)'
}

const CLAUDE_HOOKS_CONFIG = {
  hooks: {
    Notification: [
      {
        matcher: 'permission_prompt|idle_prompt',
        hooks: [
          {
            type: 'command',
            command: "osascript -e 'display notification \"Claude 需要你的输入或审批！\" with title \"Claude Code\" sound name \"Glass\"'"
          }
        ]
      }
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: "osascript -e 'display notification \"任务已全部完成！\" with title \"Claude Code\" sound name \"Blow\"'; echo '__AGENTHOME_STOP__' >> .agenthome_hook_events"
          }
        ]
      }
    ]
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function ensureClaudeHooks(cwd: string): Promise<void> {
  const claudeDir = join(cwd, '.claude')
  const payload = `${JSON.stringify(CLAUDE_HOOKS_CONFIG, null, 2)}\n`
  await mkdir(claudeDir, { recursive: true })
  await Promise.all([
    writeFile(join(claudeDir, 'settings.json'), payload, 'utf-8'),
    writeFile(join(claudeDir, 'settings.local.json'), payload, 'utf-8')
  ])
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'AgentHome',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  log.info('Main window created')
}

function openTaskCreateWindow(): void {
  if (taskCreateWindow && !taskCreateWindow.isDestroyed()) {
    taskCreateWindow.focus()
    return
  }

  taskCreateWindow = new BrowserWindow({
    width: 560,
    height: 480,
    minWidth: 520,
    minHeight: 420,
    title: '创建任务',
    parent: mainWindow ?? undefined,
    modal: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  if (process.env.NODE_ENV === 'development') {
    taskCreateWindow.loadURL('http://localhost:5173/#/task-create')
  } else {
    taskCreateWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/task-create' })
  }

  taskCreateWindow.on('closed', () => {
    taskCreateWindow = null
  })
}

function appendInteraction(taskId: string, text: string): void {
  const lines = interactionBuffers.get(taskId) ?? []
  lines.push(text)
  if (lines.length > 1000) lines.splice(0, lines.length - 1000)
  interactionBuffers.set(taskId, lines)
  const target = tasks.find(t => t.id === taskId)
  if (target?.runtimeMode === 'acp') return
  mainWindow?.webContents.send('pty-data', taskId, text)
}

function ensureAcpRegistry(): AcpRuntimeRegistry | null {
  if (!ACP_ENABLE) return null
  if (!acpRegistry) {
    acpRegistry = new AcpRuntimeRegistry((event) => {
      mainWindow?.webContents.send('acp-session-update', event)
      const target = tasks.find(t => t.id === event.taskId)
      if (!target) return
      if (event.type === 'sessionUpdate') {
        target.status = 'running'
        schedulePersistTasks()
        if (event.chunkKind !== 'thought') {
          appendInteraction(event.taskId, event.chunk ?? '')
        }
        return
      }
      if (event.type === 'toolCall' || event.type === 'toolCallUpdate') {
        target.status = 'running'
        schedulePersistTasks()
        return
      }
      if (event.type === 'permissionRequest') {
        target.status = 'waiting_input'
        schedulePersistTasks()
        appendInteraction(
          event.taskId,
          `[system] ACP permission/input requested: ${event.message ?? 'permission required'}\n`
        )
        if (ACP_AUTO_APPROVE_PERMISSION) {
          acpRegistry?.getBySessionId(event.sessionId)?.respondPermission(true)
          appendInteraction(event.taskId, '[system] ACP permission auto-approved\n')
          target.status = 'running'
          schedulePersistTasks()
        }
        return
      }
      if (event.type === 'sessionDone') {
        const code = event.exitCode ?? 0
        const cancelled = code === 130
        target.status = code === 0 || cancelled ? 'waiting_input' : 'interrupted'
        target.exitCode = event.exitCode ?? null
        if (code !== 0 && !cancelled) target.finishedAt = Date.now()
        schedulePersistTasks()
        appendInteraction(
          event.taskId,
          cancelled
            ? '[system] ACP turn cancelled (Esc), session kept, status -> 等待输入\n'
            : '[system] ACP turn done, status -> 等待输入\n'
        )
        return
      }
      if (event.type === 'sessionError') {
        target.lastError = event.message ?? 'ACP session error'
        target.status = 'waiting_input'
        schedulePersistTasks()
        appendInteraction(event.taskId, `[system] ACP session error: ${event.message ?? 'unknown'}\n`)
      }
    })
  }
  return acpRegistry
}

function startStopWatcher(taskId: string, cwd: string): void {
  const hookFile = join(cwd, '.agenthome_hook_events')
  hookEventOffsets.set(taskId, 0)

  const timer = setInterval(async () => {
    try {
      const raw = await readFile(hookFile, 'utf-8')
      const offset = hookEventOffsets.get(taskId) ?? 0
      if (raw.length <= offset) return
      const delta = raw.slice(offset)
      hookEventOffsets.set(taskId, raw.length)
      if (!delta.includes('__AGENTHOME_STOP__')) return
      const target = tasks.find(t => t.id === taskId)
      if (!target) return
      if (target.status === 'running') {
        target.status = 'waiting_input'
        schedulePersistTasks()
      }
      appendInteraction(taskId, '[system] stop hook detected, status -> 等待输入\n')
    } catch {
      // ignore until hook file exists
    }
  }, 1500)

  stopWatchers.set(taskId, timer)
}

function stopStopWatcher(taskId: string): void {
  const timer = stopWatchers.get(taskId)
  if (timer) {
    clearInterval(timer)
    stopWatchers.delete(taskId)
  }
  hookEventOffsets.delete(taskId)
}

function stopTaskExecution(task: Task, reason: string): void {
  const p = ptyMap.get(task.id)
  if (p) {
    try { p.kill() } catch {}
    ptyMap.delete(task.id)
  }
  const registry = ensureAcpRegistry()
  if (registry) {
    void registry.dispose(task.id).catch(() => {})
    acpSessionIdByTask.delete(task.id)
  }
  stopStopWatcher(task.id)
  appendInteraction(task.id, `[system] ${reason}\n`)
}

function setTaskAcpSessionId(task: Task, sessionId: string): void {
  task.acpSessionId = sessionId
  acpSessionIdByTask.set(task.id, sessionId)
  schedulePersistTasks()
}

function prepareAcpRuntime(task: Task): AcpTaskRuntime {
  const registry = ensureAcpRegistry()
  if (!registry) throw new Error('ACP registry unavailable')
  const runtime = registry.getOrCreate(task.id)
  runtime.setPersistedSessionId(task.acpSessionId)
  return runtime
}

async function tryStartAcpSession(task: Task, cwd: string): Promise<boolean> {
  const registry = ensureAcpRegistry()
  if (!registry) return false
  try {
    const runtime = prepareAcpRuntime(task)
    if (task.acpSessionId) {
      const { sessionId } = await runtime.resumePersistedSession(cwd, task.acpSessionId)
      setTaskAcpSessionId(task, sessionId)
      task.runtimeMode = 'acp'
      task.lastError = undefined
      task.runtimeReason = '已恢复 ACP 会话'
      appendInteraction(task.id, `[system] ACP session resumed: ${sessionId}\n`)
      schedulePersistTasks()
      return true
    }
    const initialPrompt = task.description?.trim()
    const { sessionId } = await runtime.sendPrompt(
      cwd,
      initialPrompt || '请先进行任务分析并给出第一步执行建议。'
    )
    setTaskAcpSessionId(task, sessionId)
    task.runtimeMode = 'acp'
    task.lastError = undefined
    task.runtimeReason = '已连接 ACP 会话'
    appendInteraction(task.id, `[system] ACP session started: ${sessionId}\n`)
    schedulePersistTasks()
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ACP start failed'
    task.lastError = message
    task.runtimeMode = 'legacy'
    task.runtimeReason = `ACP 启动失败，已回退终端模式: ${message}`
    appendInteraction(task.id, `[system] ACP unavailable, fallback to legacy: ${message}\n`)
    schedulePersistTasks()
    return false
  }
}

function seedChatUserMessage(task: Task): void {
  const desc = task.description?.trim()
  if (!desc) return
  const existing = chatHistories.get(task.id) ?? []
  if (existing.some((m) => m.role === 'user')) return
  chatHistories.set(task.id, [
    { id: `user-init-${task.id}`, role: 'user', content: desc },
    ...existing
  ])
  schedulePersistChat(task.id, chatHistories.get(task.id) ?? [])
}

async function startTaskExecution(task: Task): Promise<void> {
  if (task.status === 'running' || task.status === 'waiting_input') return
  seedChatUserMessage(task)
  const cwd = task.workPath || process.cwd()
  task.startedAt = Date.now()
  task.finishedAt = undefined
  task.exitCode = undefined
  task.lastError = undefined
  task.status = 'running'
  task.runtimeMode = 'legacy'
  task.runtimeReason = getAcpUnavailableReason(task.agent)
  task.runtimeEndpoint = ACP_ENDPOINT || '(未配置)'
  schedulePersistTasks()

  if (task.agent === 'claude-code') {
    const acpReady = await tryStartAcpSession(task, cwd)
    if (!acpReady) {
      task.runtimeMode = 'legacy'
      if (!task.runtimeReason) task.runtimeReason = getAcpUnavailableReason(task.agent)
    }
  }
  if (task.agent === 'claude-code' && task.runtimeMode !== 'acp') {
    await ensureClaudeHooks(cwd)
    appendInteraction(task.id, `[system] hooks written: ${join(cwd, '.claude', 'settings.json')}\n`)
    appendInteraction(task.id, `[system] hooks written: ${join(cwd, '.claude', 'settings.local.json')}\n`)
    startStopWatcher(task.id, cwd)
  }
  if (task.runtimeMode === 'acp') {
    appendInteraction(task.id, `[system] ACP mode started: ${task.command}\n`)
    appendInteraction(task.id, `[system] cwd: ${cwd}\n`)
    return
  }
  appendInteraction(task.id, `[system] terminal started: ${task.command}\n`)
  appendInteraction(task.id, `[system] cwd: ${cwd}\n`)
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'zsh'
  const ptyProcess = pty.spawn(shell, ['-c', task.command], {
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' } as { [key: string]: string }
  })

  ptyMap.set(task.id, ptyProcess)

  ptyProcess.onData((data: string) => {
    if (data.includes('__AGENTHOME_STOP__') && task.status === 'running') {
      task.status = 'waiting_input'
      schedulePersistTasks()
      appendInteraction(task.id, '[system] stop hook triggered, waiting for your input.\n')
      return
    }
    appendInteraction(task.id, data)
  })

  ptyProcess.onExit(({ exitCode }) => {
    ptyMap.delete(task.id)
    stopStopWatcher(task.id)
    appendInteraction(task.id, `\n[system] process exited with code ${exitCode ?? -1}\n`)
    task.status = exitCode === 0 ? 'completed' : 'interrupted'
    task.exitCode = exitCode
    task.finishedAt = Date.now()
    schedulePersistTasks()
  })
}

async function createTask(input: CreateTaskInput): Promise<Task> {
  const baseCommand = AGENT_COMMAND_MAP[input.agent]
  if (!baseCommand) throw new Error(`unknown agent: ${input.agent}`)

  const computedName = input.name.trim() || `${input.agent} 任务`
  const desc = input.description?.trim()
  const fullCommand = desc ? `${baseCommand} ${shellSingleQuote(desc)}` : baseCommand
  const task: Task = {
    id: Date.now().toString(),
    ...input,
    name: computedName,
    command: fullCommand,
    interactions: [],
    status: 'created',
    runtimeMode: 'legacy',
    runtimeReason: '新建任务，待启动',
    runtimeEndpoint: ACP_ENDPOINT || '(未配置)',
    createdAt: input.createdAt
  }
  tasks.push(task)
  interactionBuffers.set(task.id, [])
  appendInteraction(task.id, `[system] task created, waiting to start: ${fullCommand}\n`)
  appendInteraction(task.id, `[system] cwd: ${input.workPath || process.cwd()}\n`)
  schedulePersistTasks()
  return task
}

app.whenReady().then(async () => {
  await loadPersistedState()
  createWindow()
})

app.on('before-quit', (event) => {
  if (isFlushingPersistence) return
  event.preventDefault()
  isFlushingPersistence = true
  void flushPersistence()
    .catch((error) => log.error('[persistence] flush on quit failed', error))
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  ptyMap.forEach((p) => {
    try { p.kill() } catch {}
  })
  ptyMap.clear()
  if (acpRegistry) {
    void acpRegistry.disposeAll().catch(() => {})
  }
  acpSessionIdByTask.clear()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

ipcMain.handle('get-tasks', () => {
  tasks.forEach(ensureTaskRuntimeReason)
  return tasks
})
ipcMain.handle('create-task', async (_, input: CreateTaskInput) => createTask(input))

ipcMain.handle('task-get-buffer', (_, taskId: string) => interactionBuffers.get(taskId) ?? [])

ipcMain.handle('get-chat-history', (_, taskId: string) => chatHistories.get(taskId) ?? [])

ipcMain.handle('set-chat-history', (_, taskId: string, messages: ChatMessageRecord[]) => {
  chatHistories.set(taskId, messages)
  schedulePersistChat(taskId, messages)
  return { ok: true }
})

ipcMain.handle('task-send-input', (_, taskId: string, data: string) => {
  const p = ptyMap.get(taskId)
  const target = tasks.find(t => t.id === taskId)
  if (!p && target?.runtimeMode !== 'acp') return { ok: false }
  if (target && target.status === 'waiting_input') {
    target.status = 'running'
    schedulePersistTasks()
    appendInteraction(taskId, '[system] user input received, status -> 运行中\n')
  }
  const registry = ensureAcpRegistry()
  if (registry && target?.runtimeMode === 'acp' && data.trim()) {
    const runtime = prepareAcpRuntime(target)
    void runtime.sendPrompt(target.workPath || process.cwd(), data.trim()).then(({ sessionId }) => {
      setTaskAcpSessionId(target, sessionId)
    }).catch((error) => {
      const message = error instanceof Error ? error.message : 'send input failed'
      appendInteraction(taskId, `[system] ACP send input failed: ${message}\n`)
      const task = tasks.find(t => t.id === taskId)
      if (task) task.lastError = message
    })
  }
  if (p) p.write(data)
  return { ok: true }
})

ipcMain.handle('resize-pty', (_, taskId: string, cols: number, rows: number) => {
  const p = ptyMap.get(taskId)
  if (p) { try { p.resize(cols, rows) } catch {} }
})

ipcMain.handle('kill-task', (_, taskId: string) => {
  const p = ptyMap.get(taskId)
  if (p) { p.kill(); ptyMap.delete(taskId) }
  const registry = ensureAcpRegistry()
  if (registry) {
    void registry.dispose(taskId).catch(() => {})
    acpSessionIdByTask.delete(taskId)
  }
  stopStopWatcher(taskId)
  const target = tasks.find(t => t.id === taskId)
  if (target) { target.status = 'interrupted'; target.finishedAt = Date.now(); schedulePersistTasks() }
})

ipcMain.handle('update-task-status', async (_, id, status) => {
  const target = tasks.find(t => t.id === id)
  if (target) {
    if (status === 'running') {
      await startTaskExecution(target)
    } else {
      if (status === 'completed') {
        if (target.runtimeMode === 'acp') {
          target.status = 'waiting_input'
          appendInteraction(target.id, '[system] manually moved to 完成任务, keep ACP alive, status -> 等待输入\n')
        } else {
          stopTaskExecution(target, 'manually moved to 完成任务')
          target.status = 'completed'
          target.finishedAt = Date.now()
          if (target.exitCode === undefined) target.exitCode = 0
        }
      } else if (status === 'interrupted') {
        stopTaskExecution(target, 'manually moved to 中断的任务')
        target.status = 'interrupted'
        target.finishedAt = Date.now()
      } else {
        target.status = status
        if (status === 'created') {
          stopTaskExecution(target, '任务已重置为待启动')
          target.finishedAt = undefined
          target.exitCode = undefined
          target.acpSessionId = undefined
          acpSessionIdByTask.delete(target.id)
        }
      }
      if (status === 'created') {
        target.runtimeReason = '任务已重置为待启动'
      }
    }
    schedulePersistTasks()
  }
  return { id, status }
})

ipcMain.handle('get-project-path', () => process.cwd())
ipcMain.handle('acp-send-and-stream', async (_, taskId: string, prompt: string) => {
  const target = tasks.find(t => t.id === taskId)
  const registry = ensureAcpRegistry()
  if (!target || !registry) return { ok: false }
  try {
    const runtime = prepareAcpRuntime(target)
    const { sessionId } = await runtime.sendPrompt(target.workPath || process.cwd(), prompt)
    setTaskAcpSessionId(target, sessionId)
    return { ok: true, sessionId }
  } catch (error) {
    if (error instanceof AcpTaskBusyError) {
      return { ok: false, busy: true }
    }
    throw error
  }
})
ipcMain.handle('acp-cancel', async (_, sessionId: string) => {
  const registry = ensureAcpRegistry()
  if (!registry) return { ok: false }
  const runtime = registry.getBySessionId(sessionId)
  if (runtime) await runtime.cancelCurrentTurn()
  return { ok: true }
})
ipcMain.handle('acp-cancel-by-task', async (_, taskId: string) => {
  const registry = ensureAcpRegistry()
  if (!registry) return { ok: false }
  await registry.cancelCurrentTurn(taskId)
  return { ok: true }
})
ipcMain.handle('acp-respond-permission', async (_, sessionId: string, approved: boolean) => {
  const registry = ensureAcpRegistry()
  if (!registry) return { ok: false }
  registry.getBySessionId(sessionId)?.respondPermission(approved)
  return { ok: true }
})
ipcMain.handle('get-acp-task-busy', (_, taskId: string) => {
  const registry = ensureAcpRegistry()
  return { busy: registry?.isBusy(taskId) ?? false }
})
ipcMain.handle('get-acp-session-id', (_, taskId: string) => {
  const fromMap = acpSessionIdByTask.get(taskId) ?? null
  if (fromMap) return { sessionId: fromMap }
  const target = tasks.find(t => t.id === taskId)
  if (target?.acpSessionId) return { sessionId: target.acpSessionId }
  const registry = ensureAcpRegistry()
  const runtimeId = registry?.get(taskId)?.getSessionId() ?? null
  return { sessionId: runtimeId }
})
ipcMain.handle('acp-resume-session', async (_, taskId: string) => {
  const target = tasks.find(t => t.id === taskId)
  const registry = ensureAcpRegistry()
  if (!target || !registry || !target.acpSessionId) return { ok: false, reason: 'no_session' }
  if (target.runtimeMode !== 'acp') return { ok: false, reason: 'not_acp' }
  try {
    const runtime = prepareAcpRuntime(target)
    const cwd = target.workPath || process.cwd()
    const { sessionId } = await runtime.resumePersistedSession(cwd, target.acpSessionId)
    setTaskAcpSessionId(target, sessionId)
    target.runtimeReason = '已恢复 ACP 会话'
    appendInteraction(taskId, `[system] ACP session resumed: ${sessionId}\n`)
    return { ok: true, sessionId }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'resume failed'
    target.lastError = message
    appendInteraction(taskId, `[system] ACP resume failed: ${message}\n`)
    return { ok: false, reason: message }
  }
})
ipcMain.handle('get-task-runtime-mode', (_, taskId: string) => {
  const target = tasks.find(t => t.id === taskId)
  return target?.runtimeMode ?? null
})

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('open-task-create-window', () => {
  openTaskCreateWindow()
  return true
})