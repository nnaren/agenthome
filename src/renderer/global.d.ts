import type { CreateTaskInput, Task } from '../shared/types'

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
    }
  }
}

export {}
