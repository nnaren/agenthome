import { EventEmitter } from 'node:events'
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
    private readonly connectionManager: AcpConnectionManager
  ) {
    this.connectionManager.onMessage((msg) => this.handleProtocolMessage(msg as Record<string, unknown>))
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
    const existing = this.sessionsByTask.get(input.taskId)
    if (existing) {
      await this.sendProtocol('sendAndStream', {
        sessionId: existing.sessionId,
        taskId: input.taskId,
        command: input.command,
        cwd: input.cwd,
        prompt: input.prompt
      }, 'sendPrompt')
      return { sessionId: existing.sessionId }
    }
    const sessionId = `${input.taskId}-${Date.now()}`
    const entry: SessionEntry = {
      sessionId,
      taskId: input.taskId,
      firstEventReceived: false,
      firstEventTimeout: null
    }
    this.sessionsByTask.set(input.taskId, entry)
    this.sessionsById.set(sessionId, entry)
    entry.firstEventTimeout = setTimeout(() => {
      if (entry.firstEventReceived) return
      this.emit({
        type: 'sessionError',
        sessionId,
        taskId: input.taskId,
        message: `ACP agent 在 45 秒内未返回任何事件。当前命令: ${this.connectionManager.getAgentCommand()}。请检查命令可执行性、网络或协议版本`
      })
    }, 45000)
    await this.sendProtocol('sendAndStream', {
      sessionId,
      taskId: input.taskId,
      command: input.command,
      cwd: input.cwd,
      prompt: input.prompt
    }, 'sendAndStream')
    return { sessionId }
  }

  async cancel(sessionId: string): Promise<void> {
    const entry = this.sessionsById.get(sessionId)
    if (!entry) return
    await this.sendProtocol('cancel', { sessionId }, 'cancel')
    if (entry.firstEventTimeout) {
      clearTimeout(entry.firstEventTimeout)
      entry.firstEventTimeout = null
    }
    this.sessionsById.delete(sessionId)
    this.sessionsByTask.delete(entry.taskId)
  }

  async cancelByTaskId(taskId: string): Promise<void> {
    const entry = this.sessionsByTask.get(taskId)
    if (!entry) return
    await this.cancel(entry.sessionId)
  }

  async respondPermission(sessionId: string, approved: boolean): Promise<void> {
    const entry = this.sessionsById.get(sessionId)
    if (!entry) return
    await this.sendProtocol('respondPermission', { sessionId, approved }, 'respondPermission')
  }

  getSessionIdByTaskId(taskId: string): string | null {
    return this.sessionsByTask.get(taskId)?.sessionId ?? null
  }

  private emit(event: AcpFrontendEvent): void {
    this.emitter.emit('event', event)
  }

  private handleProtocolMessage(msg: Record<string, unknown>): void {
    const type = typeof msg.type === 'string' ? msg.type : ''
    const method = typeof msg.method === 'string' ? msg.method : ''
    const params = (msg.params && typeof msg.params === 'object') ? msg.params as Record<string, unknown> : {}
    const from = { ...params, ...msg }
    const resolvedType = type || method
    if (!resolvedType) return
    if (resolvedType.includes('initialize')) return
    if (resolvedType === 'agentStderr') {
      const message = String(from.message ?? '').trim()
      if (!message) return
      this.sessionsById.forEach((entry) => {
        this.emit({
          type: 'sessionError',
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          message: `[agent-stderr] ${message}`
        })
      })
      return
    }
    if (resolvedType === 'agentExit') {
      const exitCode = typeof from.exitCode === 'number' ? from.exitCode : null
      const signal = from.signal ? String(from.signal) : ''
      this.sessionsById.forEach((entry) => {
        this.emit({
          type: 'sessionError',
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          message: `[agent-exit] code=${exitCode ?? 'null'}${signal ? ` signal=${signal}` : ''}`
        })
      })
      return
    }
    if (resolvedType === 'sessionUpdate' || resolvedType === 'session.update' || resolvedType === 'session/update') {
      const sessionId = String(from.sessionId ?? '')
      const entry = this.sessionsById.get(sessionId)
      if (!entry) return
      entry.firstEventReceived = true
      if (entry.firstEventTimeout) {
        clearTimeout(entry.firstEventTimeout)
        entry.firstEventTimeout = null
      }
      this.emit({
        type: 'sessionUpdate',
        sessionId,
        taskId: entry.taskId,
        chunk: String(from.chunk ?? from.delta ?? from.text ?? '')
      })
      return
    }
    if (resolvedType === 'sessionDone' || resolvedType === 'session.done' || resolvedType === 'session/done') {
      const sessionId = String(from.sessionId ?? '')
      const entry = this.sessionsById.get(sessionId)
      if (!entry) return
      entry.firstEventReceived = true
      if (entry.firstEventTimeout) {
        clearTimeout(entry.firstEventTimeout)
        entry.firstEventTimeout = null
      }
      this.emit({
        type: 'sessionDone',
        sessionId,
        taskId: entry.taskId,
        exitCode: typeof from.exitCode === 'number' ? from.exitCode : 0
      })
      return
    }
    if (resolvedType === 'sessionError' || resolvedType === 'session.error' || resolvedType === 'session/error') {
      const sessionId = String(from.sessionId ?? '')
      const entry = this.sessionsById.get(sessionId)
      if (!entry) return
      entry.firstEventReceived = true
      if (entry.firstEventTimeout) {
        clearTimeout(entry.firstEventTimeout)
        entry.firstEventTimeout = null
      }
      this.emit({
        type: 'sessionError',
        sessionId,
        taskId: entry.taskId,
        message: String(from.message ?? 'ACP protocol error')
      })
      return
    }
    if (resolvedType === 'permissionRequest' || resolvedType === 'permission.request' || resolvedType === 'permission/request') {
      const sessionId = String(from.sessionId ?? '')
      const entry = this.sessionsById.get(sessionId)
      if (!entry) return
      entry.firstEventReceived = true
      if (entry.firstEventTimeout) {
        clearTimeout(entry.firstEventTimeout)
        entry.firstEventTimeout = null
      }
      this.emit({
        type: 'permissionRequest',
        sessionId,
        taskId: entry.taskId,
        message: String(from.message ?? 'permission required')
      })
      return
    }
    this.emit({
      type: 'sessionError',
      sessionId: String(from.sessionId ?? 'unknown'),
      taskId: String(from.taskId ?? 'unknown'),
      message: `unhandled ACP message: ${resolvedType}`
    })
  }

  private async sendProtocol(method: string, params: Record<string, unknown>, type: string): Promise<void> {
    await this.connectionManager.send({
      jsonrpc: '2.0',
      id: this.connectionManager.nextId(),
      method,
      params,
      type,
      ...params
    })
  }
}
