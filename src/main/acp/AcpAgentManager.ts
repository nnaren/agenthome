import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export class AcpAgentManager {
  private started = false
  private child: ChildProcessWithoutNullStreams | null = null
  private onExitHandler: (() => void) | null = null
  private readonly command = process.env.AGENTHOME_ACP_AGENT_COMMAND?.trim()
    || 'npx --yes @agentclientprotocol/claude-agent-acp@latest --acp'

  setOnExit(handler: () => void): void {
    this.onExitHandler = handler
  }

  isChildAlive(): boolean {
    return this.child != null && this.child.exitCode === null && !this.child.killed
  }

  async startIfNeeded(): Promise<void> {
    if (this.isChildAlive()) return
    this.child = null
    this.started = false

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'zsh'
    const shellArgs = process.platform === 'win32'
      ? ['-Command', this.command]
      : ['-c', this.command]
    this.child = spawn(shell, shellArgs, {
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: 'pipe'
    })
    this.started = true

    this.child.on('exit', () => {
      this.child = null
      this.started = false
      this.onExitHandler?.()
    })
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
