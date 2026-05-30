import { EventEmitter } from 'node:events'
import { AcpClientBridge } from './AcpClientBridge'
import { AcpConnectionManager } from './AcpConnectionManager'
import type { AcpFrontendEvent, AcpSendAndStreamInput } from './types'

interface SessionEntry {
  sessionId: string
  taskId: string
  firstEventReceived: boolean
  firstEventTimeout: NodeJS.Timeout | null
}

export class AcpSessionManager {
  private readonly emitter = new EventEmitter()
  private readonly sessionsByTask = new Map<string, SessionEntry>()
  private readonly sessionsById = new Map<string, SessionEntry>()

  constructor(
    private readonly connectionManager: AcpConnectionManager,
    private readonly clientBridge: AcpClientBridge
  ) {
    this.connectionManager.setAgentStderrHandler((message) => {
      this.sessionsById.forEach((entry) => {
        this.emit({
          type: 'sessionError',
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          message: `[agent-stderr] ${message}`
        })
      })
    })
    this.clientBridge.onEvent((event) => {
      const entry = this.sessionsById.get(event.sessionId)
      if (entry && (event.type === 'sessionUpdate' || event.type === 'permissionRequest')) {
        entry.firstEventReceived = true
        if (entry.firstEventTimeout) {
          clearTimeout(entry.firstEventTimeout)
          entry.firstEventTimeout = null
        }
      }
      this.emit(event)
    })
  }

  async connectIfNeeded(): Promise<void> {
    await this.connectionManager.initialize()
  }

  onEvent(handler: (event: AcpFrontendEvent) => void): () => void {
    this.emitter.on('event', handler)
    return () => this.emitter.removeListener('event', handler)
  }

  async sendAndStream(input: AcpSendAndStreamInput): Promise<{ sessionId: string }> {
    await this.connectIfNeeded()
    const connection = this.connectionManager.getConnection()
    const existing = this.sessionsByTask.get(input.taskId)
    if (existing) {
      await this.runPrompt(connection, existing, input.prompt)
      return { sessionId: existing.sessionId }
    }

    const sessionResult = await connection.newSession({
      cwd: input.cwd,
      mcpServers: []
    })
    const sessionId = sessionResult.sessionId
    const entry: SessionEntry = {
      sessionId,
      taskId: input.taskId,
      firstEventReceived: false,
      firstEventTimeout: null
    }
    this.sessionsByTask.set(input.taskId, entry)
    this.sessionsById.set(sessionId, entry)
    this.clientBridge.bindSession(sessionId, input.taskId)
    entry.firstEventTimeout = setTimeout(() => {
      if (entry.firstEventReceived) return
      this.emit({
        type: 'sessionError',
        sessionId,
        taskId: input.taskId,
        message: `ACP agent 在 45 秒内未返回任何事件。当前命令: ${this.connectionManager.getAgentCommand()}。请检查命令可执行性、网络或协议版本`
      })
    }, 45000)

    await this.runPrompt(connection, entry, input.prompt)
    return { sessionId }
  }

  async cancel(sessionId: string): Promise<void> {
    const entry = this.sessionsById.get(sessionId)
    if (!entry) return
    try {
      const connection = this.connectionManager.getConnection()
      await connection.cancel({ sessionId })
    } catch {
      // ignore if connection already closed
    }
    if (entry.firstEventTimeout) {
      clearTimeout(entry.firstEventTimeout)
      entry.firstEventTimeout = null
    }
    this.clientBridge.unbindSession(sessionId)
    this.sessionsById.delete(sessionId)
    this.sessionsByTask.delete(entry.taskId)
  }

  async cancelByTaskId(taskId: string): Promise<void> {
    const entry = this.sessionsByTask.get(taskId)
    if (!entry) return
    await this.cancel(entry.sessionId)
  }

  respondPermission(sessionId: string, approved: boolean): void {
    this.clientBridge.respondPermission(sessionId, approved)
  }

  getSessionIdByTaskId(taskId: string): string | null {
    return this.sessionsByTask.get(taskId)?.sessionId ?? null
  }

  private async runPrompt(
    connection: ReturnType<AcpConnectionManager['getConnection']>,
    entry: SessionEntry,
    prompt: string
  ): Promise<void> {
    try {
      const result = await connection.prompt({
        sessionId: entry.sessionId,
        prompt: [{ type: 'text', text: prompt }]
      })
      entry.firstEventReceived = true
      if (entry.firstEventTimeout) {
        clearTimeout(entry.firstEventTimeout)
        entry.firstEventTimeout = null
      }
      const exitCode = result.stopReason === 'cancelled' ? 130 : 0
      this.emit({
        type: 'sessionDone',
        sessionId: entry.sessionId,
        taskId: entry.taskId,
        exitCode
      })
    } catch (error) {
      entry.firstEventReceived = true
      if (entry.firstEventTimeout) {
        clearTimeout(entry.firstEventTimeout)
        entry.firstEventTimeout = null
      }
      this.emit({
        type: 'sessionError',
        sessionId: entry.sessionId,
        taskId: entry.taskId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private emit(event: AcpFrontendEvent): void {
    this.emitter.emit('event', event)
  }
}
