import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { buildSpawnEnv, shellInvoke } from '../shellEnv'

export class AcpAgentManager {
  private started = false
  private child: ChildProcessWithoutNullStreams | null = null
  private onExitHandler: (() => void) | null = null
  private lastStderr = ''
  private spawnCwd = process.cwd()

  constructor(private readonly command: string) {}

  setOnExit(handler: () => void): void {
    this.onExitHandler = handler
  }

  isChildAlive(): boolean {
    return this.child != null && this.child.exitCode === null && !this.child.killed
  }

  async startIfNeeded(cwd?: string): Promise<void> {
    if (cwd) this.spawnCwd = cwd
    if (this.isChildAlive()) return
    this.child = null
    this.started = false
    this.lastStderr = ''

    const { shell, args } = shellInvoke(this.command)
    this.child = spawn(shell, args, {
      cwd: this.spawnCwd,
      env: buildSpawnEnv(),
      stdio: 'pipe'
    })
    this.started = true

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      this.lastStderr = `${this.lastStderr}${text}`.slice(-4000)
    })

    this.child.on('exit', (code) => {
      if (code !== 0 && code !== null && !this.lastStderr) {
        this.lastStderr = `ACP agent exited with code ${code}`
      }
      this.child = null
      this.started = false
      this.onExitHandler?.()
    })
  }

  getLastStderr(): string {
    return this.lastStderr.trim()
  }

  isStarted(): boolean {
    return this.started
  }

  getChildProcess(): ChildProcessWithoutNullStreams | null {
    return this.child
  }

  getCommand(): string {
    return this.command
  }

  kill(): void {
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM') } catch { /* ignore */ }
    }
    this.child = null
    this.started = false
  }
}
