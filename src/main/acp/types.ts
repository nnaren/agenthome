import type { AcpFrontendEvent } from '../../shared/acp'
export type { AcpFrontendEvent }

export interface AcpSendAndStreamInput {
  taskId: string
  command: string
  cwd: string
  prompt: string
}
