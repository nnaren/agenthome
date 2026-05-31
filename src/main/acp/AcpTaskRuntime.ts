import { AcpAgentManager } from './AcpAgentManager'
import { AcpClientBridge } from './AcpClientBridge'
import { AcpConnectionManager } from './AcpConnectionManager'
import type { AcpFrontendEvent } from './types'

const PROMPT_TIMEOUT_MS = 10 * 60 * 1000
const FIRST_EVENT_TIMEOUT_MS = 45_000

export class AcpTaskBusyError extends Error {
  constructor() {
    super('ACP session is busy')
    this.name = 'AcpTaskBusyError'
  }
}

export class AcpTaskRuntime {
  private readonly agentManager = new AcpAgentManager()
  private readonly clientBridge = new AcpClientBridge()
  private readonly connectionManager: AcpConnectionManager
  private sessionId: string | null = null
  private persistedSessionId: string | null = null
  private sessionStale = false
  private busy = false
  private promptEpoch = 0
  private cancelRequested = false
  private firstEventTimeout: NodeJS.Timeout | null = null

  constructor(
    readonly taskId: string,
    private readonly emit: (event: AcpFrontendEvent) => void
  ) {
    this.connectionManager = new AcpConnectionManager(this.agentManager, this.clientBridge)
    this.connectionManager.setAgentStderrHandler((message) => {
      this.emit({
        type: 'sessionError',
        sessionId: this.sessionId ?? '',
        taskId: this.taskId,
        message: `[agent-stderr] ${message}`
      })
    })
    this.connectionManager.setOnAgentExit(() => this.handleAgentExit())
    this.clientBridge.onEvent((event) => {
      if (this.sessionId && event.sessionId !== this.sessionId) return
      if (
        (
          event.type === 'sessionUpdate'
          || event.type === 'permissionRequest'
          || event.type === 'toolCall'
          || event.type === 'toolCallUpdate'
        )
        && this.firstEventTimeout
      ) {
        clearTimeout(this.firstEventTimeout)
        this.firstEventTimeout = null
      }
      this.emit(event)
    })
  }

  isBusy(): boolean {
    return this.busy
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  setPersistedSessionId(sessionId: string | null | undefined): void {
    this.persistedSessionId = sessionId?.trim() ? sessionId.trim() : null
  }

  respondPermission(approved: boolean): void {
    if (!this.sessionId) return
    this.clientBridge.respondPermission(this.sessionId, approved)
  }

  async dispose(): Promise<void> {
    await this.destroySession()
    this.agentManager.kill()
    this.connectionManager.reset()
  }

  /** 仅取消当前 prompt 轮次（等同 Claude Code 终端 Esc），尽量保留 agent 进程 */
  async cancelCurrentTurn(): Promise<void> {
    this.promptEpoch++
    this.cancelRequested = true
    const sessionId = this.sessionId
    if (sessionId && this.connectionManager.isConnected()) {
      try {
        const connection = this.connectionManager.getConnection()
        await connection.cancel({ sessionId })
      } catch {
        // agent 可能已退出
      }
    }
    if (this.firstEventTimeout) {
      clearTimeout(this.firstEventTimeout)
      this.firstEventTimeout = null
    }
    this.busy = false

    if (!this.agentManager.isChildAlive()) {
      this.sessionStale = true
      this.emitTurnDone(130)
      void this.warmRestartAgent()
    }
  }

  private async warmRestartAgent(): Promise<void> {
    try {
      this.connectionManager.reset()
      await this.connectionManager.initialize()
    } catch {
      // 下次 sendPrompt 再试
    }
  }

  private handleAgentExit(): void {
    this.connectionManager.reset()
    this.sessionStale = true
    this.busy = false
    if (this.firstEventTimeout) {
      clearTimeout(this.firstEventTimeout)
      this.firstEventTimeout = null
    }
    if (this.cancelRequested) {
      this.cancelRequested = false
      this.emitTurnDone(130)
      void this.warmRestartAgent()
      return
    }
    this.emit({
      type: 'sessionError',
      sessionId: this.sessionId ?? '',
      taskId: this.taskId,
      message: 'ACP agent process exited'
    })
  }

  private async destroySession(): Promise<void> {
    if (this.sessionId && this.connectionManager.isConnected()) {
      try {
        const connection = this.connectionManager.getConnection()
        await connection.cancel({ sessionId: this.sessionId })
      } catch {
        // ignore
      }
      this.clientBridge.unbindSession(this.sessionId)
      this.sessionId = null
    }
    this.sessionStale = false
    if (this.firstEventTimeout) {
      clearTimeout(this.firstEventTimeout)
      this.firstEventTimeout = null
    }
    this.busy = false
  }

  private emitTurnDone(exitCode: number): void {
    if (!this.sessionId) return
    this.emit({
      type: 'sessionDone',
      sessionId: this.sessionId,
      taskId: this.taskId,
      exitCode
    })
  }

  private isBenignPromptError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /connection closed|not ready|ECONNRESET|EPIPE|broken pipe/i.test(message)
  }

  private async ensureConnection(): Promise<ReturnType<AcpConnectionManager['getConnection']>> {
    if (!this.agentManager.isChildAlive()) {
      this.connectionManager.reset()
      this.sessionStale = true
    }
    await this.connectionManager.initialize()
    return this.connectionManager.getConnection()
  }

  private bindSession(sessionId: string): void {
    if (this.sessionId && this.sessionId !== sessionId) {
      this.clientBridge.unbindSession(this.sessionId)
    }
    this.sessionId = sessionId
    this.clientBridge.bindSession(sessionId, this.taskId)
    this.sessionStale = false
  }

  private async tryAttachSession(
    connection: ReturnType<AcpConnectionManager['getConnection']>,
    cwd: string,
    sessionId: string
  ): Promise<boolean> {
    try {
      await connection.resumeSession({ sessionId, cwd, mcpServers: [] })
      this.bindSession(sessionId)
      return true
    } catch {
      // try loadSession next
    }
    try {
      await connection.loadSession({ sessionId, cwd, mcpServers: [] })
      this.bindSession(sessionId)
      return true
    } catch {
      return false
    }
  }

  private async ensureSession(
    connection: ReturnType<AcpConnectionManager['getConnection']>,
    cwd: string
  ): Promise<void> {
    if (this.sessionId && !this.sessionStale) return

    const candidateId = this.sessionId ?? this.persistedSessionId
    if (candidateId) {
      const attached = await this.tryAttachSession(connection, cwd, candidateId)
      if (attached) {
        this.persistedSessionId = null
        return
      }
      if (this.sessionId === candidateId) {
        this.clientBridge.unbindSession(this.sessionId)
        this.sessionId = null
      }
      this.persistedSessionId = null
    }

    const previous = this.sessionId
    const sessionResult = await connection.newSession({ cwd, mcpServers: [] })
    this.bindSession(sessionResult.sessionId)
    if (previous && previous !== this.sessionId) {
      this.clientBridge.unbindSession(previous)
    }
  }

  private startFirstEventTimeout(): void {
    if (this.firstEventTimeout) {
      clearTimeout(this.firstEventTimeout)
      this.firstEventTimeout = null
    }
    this.firstEventTimeout = setTimeout(() => {
      this.emit({
        type: 'sessionError',
        sessionId: this.sessionId!,
        taskId: this.taskId,
        message: `ACP agent 在 ${FIRST_EVENT_TIMEOUT_MS / 1000} 秒内未返回任何事件。当前命令: ${this.connectionManager.getAgentCommand()}`
      })
      void this.cancelCurrentTurn()
    }, FIRST_EVENT_TIMEOUT_MS)
  }

  /** 恢复已持久化的 session，不发送 prompt */
  async resumePersistedSession(cwd: string, sessionId: string): Promise<{ sessionId: string }> {
    this.persistedSessionId = sessionId
    const connection = await this.ensureConnection()
    await this.ensureSession(connection, cwd)
    if (!this.sessionId) throw new Error('ACP session was not resumed')
    return { sessionId: this.sessionId }
  }

  async sendPrompt(cwd: string, prompt: string): Promise<{ sessionId: string }> {
    if (this.busy) throw new AcpTaskBusyError()
    const turnEpoch = this.promptEpoch
    this.cancelRequested = false
    this.busy = true
    try {
      const connection = await this.ensureConnection()
      await this.ensureSession(connection, cwd)
      await this.runPrompt(connection, prompt, turnEpoch)
      if (!this.sessionId) throw new Error('ACP session was not created')
      return { sessionId: this.sessionId }
    } finally {
      if (this.promptEpoch === turnEpoch) {
        this.busy = false
      }
    }
  }

  private async runPrompt(
    connection: ReturnType<AcpConnectionManager['getConnection']>,
    prompt: string,
    turnEpoch: number
  ): Promise<void> {
    if (!this.sessionId) return
    const sessionId = this.sessionId
    this.startFirstEventTimeout()
    try {
      const result = await Promise.race([
        connection.prompt({
          sessionId,
          prompt: [{ type: 'text', text: prompt }]
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('ACP prompt timeout')), PROMPT_TIMEOUT_MS)
        })
      ])
      if (turnEpoch !== this.promptEpoch) return
      if (this.firstEventTimeout) {
        clearTimeout(this.firstEventTimeout)
        this.firstEventTimeout = null
      }
      this.emit({
        type: 'sessionDone',
        sessionId,
        taskId: this.taskId,
        exitCode: result.stopReason === 'cancelled' ? 130 : 0
      })
    } catch (error) {
      if (turnEpoch !== this.promptEpoch || this.cancelRequested) {
        this.emitTurnDone(130)
        return
      }
      if (this.isBenignPromptError(error)) {
        this.sessionStale = true
        void this.warmRestartAgent()
        this.emitTurnDone(130)
        return
      }
      if (this.firstEventTimeout) {
        clearTimeout(this.firstEventTimeout)
        this.firstEventTimeout = null
      }
      this.emit({
        type: 'sessionError',
        sessionId,
        taskId: this.taskId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
