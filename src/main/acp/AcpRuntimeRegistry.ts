import { AcpTaskRuntime } from './AcpTaskRuntime'
import type { AcpFrontendEvent } from './types'

export interface AcpRuntimeOptions {
  agentCommand: string
}

export class AcpRuntimeRegistry {
  private readonly runtimes = new Map<string, AcpTaskRuntime>()

  constructor(private readonly emit: (event: AcpFrontendEvent) => void) {}

  getOrCreate(taskId: string, options: AcpRuntimeOptions): AcpTaskRuntime {
    let runtime = this.runtimes.get(taskId)
    if (!runtime) {
      runtime = new AcpTaskRuntime(
        taskId,
        options.agentCommand,
        (event) => this.emit(event)
      )
      this.runtimes.set(taskId, runtime)
    }
    return runtime
  }

  get(taskId: string): AcpTaskRuntime | null {
    return this.runtimes.get(taskId) ?? null
  }

  getBySessionId(sessionId: string): AcpTaskRuntime | null {
    for (const runtime of this.runtimes.values()) {
      if (runtime.getSessionId() === sessionId) return runtime
    }
    return null
  }

  isBusy(taskId: string): boolean {
    return this.runtimes.get(taskId)?.isBusy() ?? false
  }

  async cancelCurrentTurn(taskId: string): Promise<boolean> {
    const runtime = this.runtimes.get(taskId)
    if (!runtime) return false
    await runtime.cancelCurrentTurn()
    return true
  }

  async dispose(taskId: string): Promise<void> {
    const runtime = this.runtimes.get(taskId)
    if (!runtime) return
    await runtime.dispose()
    this.runtimes.delete(taskId)
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.runtimes.keys()]
    await Promise.all(ids.map((id) => this.dispose(id)))
  }
}
