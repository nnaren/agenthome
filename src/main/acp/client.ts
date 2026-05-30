type AcpEventType = 'needs_input' | 'task_exit' | 'stdout' | 'error'

export interface AcpEvent {
  type: AcpEventType
  data?: string
  exitCode?: number | null
  message?: string
}

export interface StartAcpSessionPayload {
  taskId: string
  command: string
  cwd: string
  initialInput?: string
}

export interface AcpSession {
  sendUserInput: (input: string) => Promise<void>
  stop: () => Promise<void>
  onEvent: (handler: (event: AcpEvent) => void) => () => void
}

type Listener = (event: AcpEvent) => void

function normalizeBaseUrl(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint
}

export class AcpClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(endpoint: string, timeoutMs: number) {
    this.baseUrl = normalizeBaseUrl(endpoint)
    this.timeoutMs = timeoutMs
  }

  async startSession(payload: StartAcpSessionPayload): Promise<AcpSession> {
    const acpSessionId = await this.createRemoteSession(payload)
    let cursor = 0
    let destroyed = false
    let timer: NodeJS.Timeout | null = null
    const listeners = new Set<Listener>()

    const emit = (event: AcpEvent): void => {
      listeners.forEach((listener) => {
        try {
          listener(event)
        } catch {
          // avoid breaking sibling listeners
        }
      })
    }

    const pollOnce = async (): Promise<void> => {
      if (destroyed) return
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
        const response = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(acpSessionId)}/events?cursor=${cursor}`, {
          method: 'GET',
          signal: controller.signal
        })
        clearTimeout(timeout)
        if (!response.ok) {
          emit({ type: 'error', message: `ACP events poll failed: ${response.status}` })
          return
        }
        const body = await response.json() as { nextCursor?: number; events?: AcpEvent[] }
        cursor = typeof body.nextCursor === 'number' ? body.nextCursor : cursor
        const events = Array.isArray(body.events) ? body.events : []
        events.forEach((event) => emit(event))
      } catch (error) {
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : 'ACP events poll failed'
        })
      }
    }

    timer = setInterval(() => {
      void pollOnce()
    }, 120)
    void pollOnce()

    return {
      sendUserInput: async (input: string) => {
        await this.postJson(`/sessions/${encodeURIComponent(acpSessionId)}/input`, { input })
      },
      stop: async () => {
        if (destroyed) return
        destroyed = true
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        await this.postJson(`/sessions/${encodeURIComponent(acpSessionId)}/stop`, {})
      },
      onEvent: (handler: Listener) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      }
    }
  }

  private async createRemoteSession(payload: StartAcpSessionPayload): Promise<string> {
    const response = await this.postJson('/sessions', payload)
    const id = response?.sessionId
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('ACP sessionId missing in response')
    }
    return id
  }

  private async postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`ACP request failed: ${response.status}`)
      }
      return await response.json() as Record<string, unknown>
    } finally {
      clearTimeout(timeout)
    }
  }
}
