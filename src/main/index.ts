import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import * as pty from 'node-pty'
import log from 'electron-log'
import { mkdir, readFile, writeFile } from 'fs/promises'
import type { CreateTaskInput, Task } from '../shared/types'

log.info('AgentHome starting...')

let mainWindow: BrowserWindow | null = null
let taskCreateWindow: BrowserWindow | null = null

const tasks: Task[] = []
const ptyMap = new Map<string, pty.IPty>()
const interactionBuffers = new Map<string, string[]>()
const stopWatchers = new Map<string, NodeJS.Timeout>()
const hookEventOffsets = new Map<string, number>()

const AGENT_COMMAND_MAP: Record<string, string> = {
  'claude-code': 'claude',
  'flow-cli': 'flow',
  'hermes-agent': 'hermes'
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
  mainWindow?.webContents.send('pty-data', taskId, text)
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

async function createTerminalTask(input: CreateTaskInput): Promise<Task> {
  const baseCommand = AGENT_COMMAND_MAP[input.agent]
  if (!baseCommand) throw new Error(`unknown agent: ${input.agent}`)

  const cwd = input.workPath || process.cwd()
  const computedName = input.name.trim() || `${input.agent} 任务`
  const desc = input.description?.trim()
  const fullCommand = desc ? `${baseCommand} ${shellSingleQuote(desc)}` : baseCommand

  const task: Task = {
    id: Date.now().toString(),
    ...input,
    name: computedName,
    command: fullCommand,
    interactions: [],
    status: 'running',
    createdAt: input.createdAt,
    startedAt: Date.now()
  }
  tasks.push(task)
  interactionBuffers.set(task.id, [])
  if (input.agent === 'claude-code') {
    await ensureClaudeHooks(cwd)
    appendInteraction(task.id, `[system] hooks written: ${join(cwd, '.claude', 'settings.json')}\n`)
    appendInteraction(task.id, `[system] hooks written: ${join(cwd, '.claude', 'settings.local.json')}\n`)
    startStopWatcher(task.id, cwd)
  }
  appendInteraction(task.id, `[system] terminal started: ${fullCommand}\n`)
  appendInteraction(task.id, `[system] cwd: ${cwd}\n`)

  const shell = process.platform === 'win32' ? 'powershell.exe' : 'zsh'
  const ptyProcess = pty.spawn(shell, ['-c', fullCommand], {
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' } as { [key: string]: string }
  })

  ptyMap.set(task.id, ptyProcess)

  ptyProcess.onData((data: string) => {
    if (data.includes('__AGENTHOME_STOP__')) {
      const target = tasks.find(t => t.id === task.id)
      if (target && target.status === 'running') {
        target.status = 'waiting_input'
      }
      appendInteraction(task.id, '[system] stop hook triggered, waiting for your input.\n')
      return
    }
    appendInteraction(task.id, data)
  })

  ptyProcess.onExit(({ exitCode }) => {
    ptyMap.delete(task.id)
    stopStopWatcher(task.id)
    appendInteraction(task.id, `\n[system] process exited with code ${exitCode ?? -1}\n`)
    const target = tasks.find(t => t.id === task.id)
    if (target) {
      target.status = 'completed'
      target.exitCode = exitCode
      target.finishedAt = Date.now()
    }
  })

  return task
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  ptyMap.forEach((p) => {
    try { p.kill() } catch {}
  })
  ptyMap.clear()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

ipcMain.handle('get-tasks', () => tasks)
ipcMain.handle('create-task', async (_, input: CreateTaskInput) => createTerminalTask(input))

ipcMain.handle('task-get-buffer', (_, taskId: string) => interactionBuffers.get(taskId) ?? [])

ipcMain.handle('task-send-input', (_, taskId: string, data: string) => {
  const p = ptyMap.get(taskId)
  if (!p) return { ok: false }
  const target = tasks.find(t => t.id === taskId)
  if (target && target.status === 'waiting_input') {
    target.status = 'running'
    appendInteraction(taskId, '[system] user input received, status -> 运行中\n')
  }
  p.write(data)
  return { ok: true }
})

ipcMain.handle('resize-pty', (_, taskId: string, cols: number, rows: number) => {
  const p = ptyMap.get(taskId)
  if (p) { try { p.resize(cols, rows) } catch {} }
})

ipcMain.handle('kill-task', (_, taskId: string) => {
  const p = ptyMap.get(taskId)
  if (p) { p.kill(); ptyMap.delete(taskId) }
  stopStopWatcher(taskId)
  const target = tasks.find(t => t.id === taskId)
  if (target) { target.status = 'interrupted'; target.finishedAt = Date.now() }
})

ipcMain.handle('update-task-status', (_, id, status) => {
  const target = tasks.find(t => t.id === id)
  if (target) target.status = status
  return { id, status }
})

ipcMain.handle('get-project-path', () => process.cwd())

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('open-task-create-window', () => {
  openTaskCreateWindow()
  return true
})