import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readFile, writeFile, readdir } from 'fs/promises'
import log from 'electron-log'
import type { ChatMessageRecord } from '../../shared/chat'
import type { Task } from '../../shared/types'

function getDataDir(): string {
  return join(homedir(), '.agenthome', 'sessions')
}

function tasksFilePath(): string {
  return join(getDataDir(), 'tasks.jsonl')
}

function chatsDirPath(): string {
  return join(getDataDir(), 'chats')
}

function chatFilePath(taskId: string): string {
  return join(chatsDirPath(), `${taskId}.jsonl`)
}

export async function ensureDataDir(): Promise<void> {
  await mkdir(chatsDirPath(), { recursive: true })
}

function normalizeLoadedTask(task: Task): Task {
  let next = task
  if (task.status === 'running') {
    next = { ...next, status: 'waiting_input' }
  }
  if (task.acpSessionId?.trim()) {
    next = {
      ...next,
      runtimeMode: 'acp',
      runtimeReason: next.runtimeReason ?? 'ACP 会话已保存，打开任务后自动恢复'
    }
  }
  return next
}

export async function loadTasksFromDisk(): Promise<Task[]> {
  await ensureDataDir()
  try {
    const raw = await readFile(tasksFilePath(), 'utf-8')
    const byId = new Map<string, Task>()
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const record = JSON.parse(trimmed) as Task
        if (record.id) byId.set(record.id, normalizeLoadedTask(record))
      } catch (error) {
        log.warn('[persistence] skip invalid tasks.jsonl line', error)
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function saveTasksToDisk(tasks: Task[]): Promise<void> {
  await ensureDataDir()
  const lines = tasks.map((task) => JSON.stringify(task)).join('\n')
  const content = lines ? `${lines}\n` : ''
  await writeFile(tasksFilePath(), content, 'utf-8')
}

export async function loadChatFromDisk(taskId: string): Promise<ChatMessageRecord[]> {
  try {
    const raw = await readFile(chatFilePath(taskId), 'utf-8')
    const messages: ChatMessageRecord[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        messages.push(JSON.parse(trimmed) as ChatMessageRecord)
      } catch (error) {
        log.warn(`[persistence] skip invalid chat line for ${taskId}`, error)
      }
    }
    return messages
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function loadAllChatHistories(): Promise<Map<string, ChatMessageRecord[]>> {
  const map = new Map<string, ChatMessageRecord[]>()
  await ensureDataDir()
  try {
    const files = await readdir(chatsDirPath())
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const taskId = file.slice(0, -'.jsonl'.length)
      const messages = await loadChatFromDisk(taskId)
      if (messages.length > 0) map.set(taskId, messages)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return map
}

export async function saveChatToDisk(taskId: string, messages: ChatMessageRecord[]): Promise<void> {
  await ensureDataDir()
  const lines = messages.map((message) => JSON.stringify(message)).join('\n')
  const content = lines ? `${lines}\n` : ''
  await writeFile(chatFilePath(taskId), content, 'utf-8')
}

export function getPersistenceDataDir(): string {
  return getDataDir()
}
