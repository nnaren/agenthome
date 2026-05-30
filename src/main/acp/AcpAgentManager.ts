import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export class AcpAgentManager {
  private started = false
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly command = process.env.AGENTHOME_ACP_AGENT_COMMAND?.trim()
    || 'npx --yes @agentclientprotocol/claude-agent-acp@latest --acp'

  async startIfNeeded(): Promise<void> {
    if (this.started) return
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
}
