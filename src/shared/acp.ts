import type { ToolCallRecord } from './chat'

export type AcpFrontendEventType =
  | 'sessionUpdate'
  | 'sessionDone'
  | 'sessionError'
  | 'permissionRequest'
  | 'toolCall'
  | 'toolCallUpdate'

export type AcpChunkKind = 'message' | 'thought'

export interface AcpFrontendEvent {
  type: AcpFrontendEventType
  sessionId: string
  taskId: string
  chunk?: string
  chunkKind?: AcpChunkKind
  exitCode?: number | null
  message?: string
  toolCall?: ToolCallRecord
  toolCallUpdate?: Partial<ToolCallRecord> & { toolCallId: string }
}
