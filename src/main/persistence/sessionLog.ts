import { appendFile, mkdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import log from 'electron-log'
import type { Task } from '../../shared/types'

function logsDir(): string {
  return join(homedir(), '.agenthome', 'logs')
}

function sanitizeSessionKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function formatLogTimestamp(date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** taskId → 当前日志文件路径（acpSessionId 确定后固定） */
const taskLogFileByTaskId = new Map<string, string>()

function formatCreateTimeForLog(createdAt: number): string {
  const date = new Date(createdAt)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    pad(date.getMilliseconds(), 3)
  ].join('-')
}

function buildSessionLogFileName(sessionId: string, createdAt: number): string {
  return `system_log_${sanitizeSessionKey(sessionId)}_${formatCreateTimeForLog(createdAt)}.log`
}

function buildSessionLogPath(sessionId: string, createdAt: number): string {
  return join(logsDir(), buildSessionLogFileName(sessionId, createdAt))
}

export function resolveSessionLogFile(task: Pick<Task, 'id' | 'createdAt' | 'acpSessionId'>): string {
  const cached = taskLogFileByTaskId.get(task.id)
  if (cached) return cached

  const sessionId = task.acpSessionId?.trim() || `pending-${task.id}`
  const file = buildSessionLogPath(sessionId, task.createdAt)
  taskLogFileByTaskId.set(task.id, file)
  return file
}

/** 首次获得 acpSessionId 时切换到 session 专属日志文件 */
export async function bindTaskSessionLogFile(
  task: Pick<Task, 'id' | 'createdAt'>,
  acpSessionId: string
): Promise<void> {
  const sessionId = acpSessionId.trim()
  if (!sessionId) return

  const pendingFile = buildSessionLogPath(`pending-${task.id}`, task.createdAt)
  const sessionFile = buildSessionLogPath(sessionId, task.createdAt)
  const previous = taskLogFileByTaskId.get(task.id)

  if (previous === sessionFile) return

  taskLogFileByTaskId.set(task.id, sessionFile)

  const pendingFileName = buildSessionLogFileName(`pending-${task.id}`, task.createdAt)
  if (previous && previous !== sessionFile && previous.endsWith(pendingFileName)) {
    try {
      const pending = await readFile(previous, 'utf-8')
      if (pending.trim()) {
        await appendFile(sessionFile, pending, 'utf-8')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('[session-log] merge pending log failed', error)
      }
    }
  } else if (!previous) {
    try {
      const pending = await readFile(pendingFile, 'utf-8')
      if (pending.trim()) {
        await appendFile(sessionFile, pending, 'utf-8')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('[session-log] merge pending log failed', error)
      }
    }
  }
}

export async function ensureLogsDir(): Promise<void> {
  await mkdir(logsDir(), { recursive: true })
}

function normalizeLogBody(line: string): string {
  return line.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '').trim()
}

function stampLogLine(message: string, at = new Date()): string {
  const body = normalizeLogBody(message)
  if (!body) return ''
  return `[${formatLogTimestamp(at)}] ${body}`
}

export function extractSystemLogBodies(text: string): string[] {
  const bodies: string[] = []
  for (const part of text.split(/\r?\n/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    if (/\[(system|acp)\]/.test(trimmed)) {
      bodies.push(normalizeLogBody(trimmed) || trimmed)
    }
  }
  return bodies
}

export async function appendSessionSystemLog(
  task: Pick<Task, 'id' | 'createdAt' | 'acpSessionId'>,
  message: string
): Promise<void> {
  const stamped = stampLogLine(message)
  if (!stamped) return
  try {
    await ensureLogsDir()
    const file = resolveSessionLogFile(task)
    await appendFile(file, `${stamped}\n`, 'utf-8')
  } catch (error) {
    log.warn('[session-log] append failed', error)
  }
}

export async function appendSessionSystemLogs(
  task: Pick<Task, 'id' | 'createdAt' | 'acpSessionId'>,
  messages: string[]
): Promise<void> {
  if (messages.length === 0) return
  try {
    await ensureLogsDir()
    const file = resolveSessionLogFile(task)
    const payload = messages
      .map((message) => stampLogLine(message))
      .filter(Boolean)
      .join('\n')
    if (!payload) return
    await appendFile(file, `${payload}\n`, 'utf-8')
  } catch (error) {
    log.warn('[session-log] append batch failed', error)
  }
}

export async function loadSessionSystemLog(
  task: Pick<Task, 'id' | 'createdAt' | 'acpSessionId'>
): Promise<string[]> {
  try {
    await ensureLogsDir()
    const file = resolveSessionLogFile(task)
    const raw = await readFile(file, 'utf-8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    log.warn('[session-log] load failed', error)
    return []
  }
}

export function getSessionLogsDir(): string {
  return logsDir()
}
