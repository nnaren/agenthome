import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import type {
  Client,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse
} from '@agentclientprotocol/sdk'
import type { AcpFrontendEvent } from '../../shared/acp'
import type { ToolCallRecord } from '../../shared/chat'

interface PendingPermission {
  resolve: (response: RequestPermissionResponse) => void
  options: PermissionOption[]
}

export class AcpClientBridge implements Client {
  private readonly emitter = new EventEmitter()
  private readonly sessionToTask = new Map<string, string>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()

  onEvent(handler: (event: AcpFrontendEvent) => void): () => void {
    this.emitter.on('event', handler)
    return () => this.emitter.removeListener('event', handler)
  }

  bindSession(sessionId: string, taskId: string): void {
    this.sessionToTask.set(sessionId, taskId)
  }

  unbindSession(sessionId: string): void {
    this.sessionToTask.delete(sessionId)
    this.pendingPermissions.delete(sessionId)
  }

  getTaskId(sessionId: string): string | undefined {
    return this.sessionToTask.get(sessionId)
  }

  respondPermission(sessionId: string, approved: boolean): void {
    const pending = this.pendingPermissions.get(sessionId)
    if (!pending) return
    this.pendingPermissions.delete(sessionId)
    if (!approved) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      return
    }
    const allowOption = pending.options.find((o) =>
      o.kind === 'allow_once' || o.kind === 'allow_always'
    ) ?? pending.options[0]
    pending.resolve({
      outcome: {
        outcome: 'selected',
        optionId: allowOption.optionId
      }
    })
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const taskId = this.sessionToTask.get(params.sessionId)
    if (!taskId) return
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.emit({
        type: 'sessionUpdate',
        sessionId: params.sessionId,
        taskId,
        chunk: update.content.text,
        chunkKind: 'message'
      })
      return
    }
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      this.emit({
        type: 'sessionUpdate',
        sessionId: params.sessionId,
        taskId,
        chunk: update.content.text,
        chunkKind: 'thought'
      })
      return
    }
    if (update.sessionUpdate === 'tool_call') {
      this.emit({
        type: 'toolCall',
        sessionId: params.sessionId,
        taskId,
        toolCall: {
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status,
          kind: update.kind,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput
        }
      })
      return
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const toolCallUpdate: Partial<ToolCallRecord> & { toolCallId: string } = {
        toolCallId: update.toolCallId
      }
      if (update.title != null && update.title !== '') toolCallUpdate.title = update.title
      if (update.status != null) toolCallUpdate.status = update.status
      if (update.kind != null) toolCallUpdate.kind = update.kind
      if (update.rawInput !== undefined) toolCallUpdate.rawInput = update.rawInput
      if (update.rawOutput !== undefined) toolCallUpdate.rawOutput = update.rawOutput
      this.emit({
        type: 'toolCallUpdate',
        sessionId: params.sessionId,
        taskId,
        toolCallUpdate
      })
    }
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const taskId = this.sessionToTask.get(params.sessionId)
    if (!taskId) {
      return { outcome: { outcome: 'cancelled' } }
    }
    return new Promise((resolve) => {
      this.pendingPermissions.set(params.sessionId, {
        resolve,
        options: params.options
      })
      this.emit({
        type: 'permissionRequest',
        sessionId: params.sessionId,
        taskId,
        message: params.toolCall.title ?? 'permission required'
      })
    })
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const content = await readFile(params.path, 'utf-8')
    return { content }
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    await writeFile(params.path, params.content, 'utf-8')
    return {}
  }

  private emit(event: AcpFrontendEvent): void {
    this.emitter.emit('event', event)
  }
}
