import type { CreateTaskInput, Task } from '../shared/types'
import type { AcpFrontendEvent } from '../shared/acp'

declare global {
  interface Window {
    electronAPI: {
      getTasks: () => Promise<Task[]>
      createTask: (task: CreateTaskInput) => Promise<Task>
      updateTaskStatus: (id: string, status: Task['status']) => Promise<{ id: string; status: string }>
      sendTaskInput: (taskId: string, data: string) => Promise<{ ok: boolean }>
      getTaskBuffer: (taskId: string) => Promise<string[]>
      resizePty: (taskId: string, cols: number, rows: number) => Promise<void>
      killTask: (taskId: string) => Promise<void>
      onPtyData: (callback: (taskId: string, data: string) => void) => () => void
      getProjectPath: () => Promise<string>
      selectDirectory: () => Promise<string | null>
      openTaskCreateWindow: () => Promise<boolean>
      getTaskRuntimeMode: (taskId: string) => Promise<'legacy' | 'acp' | null>
      acpSendAndStream: (taskId: string, prompt: string) => Promise<{ ok: boolean; sessionId?: string }>
      acpCancel: (sessionId: string) => Promise<{ ok: boolean }>
      acpRespondPermission: (sessionId: string, approved: boolean) => Promise<{ ok: boolean }>
      onAcpSessionUpdate: (callback: (event: AcpFrontendEvent) => void) => () => void
    }
  }
}

export {}
