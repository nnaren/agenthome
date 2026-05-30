import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION
} from '@agentclientprotocol/sdk'
import { AcpAgentManager } from './AcpAgentManager'
import { AcpClientBridge } from './AcpClientBridge'

export class AcpConnectionManager {
  private connection: ClientSideConnection | null = null
  private initPromise: Promise<void> | null = null
  private onAgentStderr: ((message: string) => void) | null = null
  constructor(
    private readonly agentManager: AcpAgentManager,
    private readonly clientBridge: AcpClientBridge
  ) {}

  setAgentStderrHandler(handler: (message: string) => void): void {
    this.onAgentStderr = handler
  }

  setOnAgentExit(handler: () => void): void {
    this.agentManager.setOnExit(handler)
  }

  reset(): void {
    this.connection = null
    this.initPromise = null
  }

  async initialize(): Promise<void> {
    if (this.connection && this.agentManager.isChildAlive()) return
    if (this.initPromise && this.agentManager.isChildAlive()) return this.initPromise
    this.reset()
    this.initPromise = this.doInitialize()
    return this.initPromise
  }

  isConnected(): boolean {
    return this.connection !== null && this.agentManager.isChildAlive()
  }

  getConnection(): ClientSideConnection {
    if (!this.connection || !this.agentManager.isChildAlive()) {
      throw new Error('ACP connection is not ready')
    }
    return this.connection
  }

  getAgentCommand(): string {
    return this.agentManager.getCommand()
  }

  private async doInitialize(): Promise<void> {
    await this.agentManager.startIfNeeded()
    const child = this.agentManager.getChildProcess()
    if (!child) throw new Error('ACP agent process not started')

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      const trimmed = text.trim()
      if (!trimmed || !this.onAgentStderr) return
      this.onAgentStderr(trimmed)
    })

    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    const stream = ndJsonStream(input, output)
    this.connection = new ClientSideConnection(() => this.clientBridge, stream)

    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true
        }
      },
      clientInfo: {
        name: 'AgentHome',
        version: '0.1.0'
      }
    })
  }
}
