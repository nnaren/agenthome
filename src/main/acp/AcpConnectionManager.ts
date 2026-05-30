import { AcpAgentManager } from './AcpAgentManager'
import { ndJsonStream } from './ndJsonStream'

interface AcpProtocolMessage {
  type: string
  [key: string]: unknown
}

export class AcpConnectionManager {
  private connected = false
  private writer: WritableStreamDefaultWriter<AcpProtocolMessage> | null = null
  private readonly listeners = new Set<(msg: AcpProtocolMessage) => void>()
  private msgId = 0

  constructor(private readonly agentManager: AcpAgentManager) {}

  async initialize(): Promise<void> {
    if (this.connected) return
    await this.agentManager.startIfNeeded()
    const child = this.agentManager.getChildProcess()
    if (child) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        this.listeners.forEach((listener) => listener({
          type: 'agentStderr',
          message: text
        }))
      })
      child.on('exit', (code, signal) => {
        this.listeners.forEach((listener) => listener({
          type: 'agentExit',
          exitCode: code ?? null,
          signal: signal ?? null
        }))
      })

      const stdinStream = this.createWritableStream(child.stdin)
      const stdoutStream = this.createReadableStream(child.stdout)
      const codec = ndJsonStream<AcpProtocolMessage, AcpProtocolMessage>()

      void stdoutStream.pipeThrough(codec.decode).pipeTo(new WritableStream<AcpProtocolMessage>({
        write: (msg) => {
          this.listeners.forEach((listener) => listener(msg))
        }
      }))
      this.writer = codec.encode.writable.getWriter()
      void codec.encode.readable.pipeTo(stdinStream)
    }
    this.connected = true
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: AcpProtocolMessage) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  async send(msg: AcpProtocolMessage): Promise<void> {
    if (!this.writer) throw new Error('ACP NDJSON writer is not ready')
    await this.writer.write(msg)
  }

  nextId(): string {
    this.msgId += 1
    return `acp-${Date.now()}-${this.msgId}`
  }

  getAgentCommand(): string {
    return this.agentManager.getCommand()
  }

  private createReadableStream(nodeReadable: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        nodeReadable.on('data', (chunk: Buffer | string) => {
          const value = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
          controller.enqueue(value)
        })
        nodeReadable.on('end', () => controller.close())
        nodeReadable.on('error', (error) => controller.error(error))
      }
    })
  }

  private createWritableStream(nodeWritable: NodeJS.WritableStream): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          nodeWritable.write(Buffer.from(chunk), (error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      }
    })
  }
}
