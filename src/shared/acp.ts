export type AcpFrontendEventType = 'sessionUpdate' | 'sessionDone' | 'sessionError' | 'permissionRequest'

export interface AcpFrontendEvent {
  type: AcpFrontendEventType
  sessionId: string
  taskId: string
  chunk?: string
  exitCode?: number | null
  message?: string
}
