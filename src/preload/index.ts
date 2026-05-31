import { contextBridge, ipcRenderer } from 'electron'
import type { CreateTaskInput, Task } from '../shared/types'
import type { AcpFrontendEvent } from '../shared/acp'
import type { ChatMessageRecord } from '../shared/chat'

export interface ElectronAPI {
  getTasks: () => Promise<Task[]>
  createTask: (task: CreateTaskInput) => Promise<Task>
  updateTaskStatus: (id: string, status: Task['status']) => Promise<{ id: string; status: string }>
  sendTaskInput: (taskId: string, data: string) => Promise<{ ok: boolean }>
  getTaskBuffer: (taskId: string) => Promise<string[]>
  getChatHistory: (taskId: string) => Promise<ChatMessageRecord[]>
  setChatHistory: (taskId: string, messages: ChatMessageRecord[]) => Promise<{ ok: boolean }>
  resizePty: (taskId: string, cols: number, rows: number) => Promise<void>
  killTask: (taskId: string) => Promise<void>
  onPtyData: (callback: (taskId: string, data: string) => void) => () => void
  getProjectPath: () => Promise<string>
  selectDirectory: () => Promise<string | null>
  openTaskCreateWindow: () => Promise<boolean>
  getTaskRuntimeMode: (taskId: string) => Promise<'legacy' | 'acp' | null>
  acpSendAndStream: (taskId: string, prompt: string) => Promise<{ ok: boolean; sessionId?: string; busy?: boolean }>
  acpCancel: (sessionId: string) => Promise<{ ok: boolean }>
  acpRespondPermission: (sessionId: string, approved: boolean) => Promise<{ ok: boolean }>
  acpCancelByTask: (taskId: string) => Promise<{ ok: boolean }>
  getAcpTaskBusy: (taskId: string) => Promise<{ busy: boolean }>
  getAcpSessionId: (taskId: string) => Promise<{ sessionId: string | null }>
  acpResumeSession: (taskId: string) => Promise<{ ok: boolean; sessionId?: string; reason?: string }>
  onAcpSessionUpdate: (callback: (event: AcpFrontendEvent) => void) => () => void
}

const api: ElectronAPI = {
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  createTask: (task) => ipcRenderer.invoke('create-task', task),
  updateTaskStatus: (id, status) => ipcRenderer.invoke('update-task-status', id, status),
  sendTaskInput: (taskId, data) => ipcRenderer.invoke('task-send-input', taskId, data),
  getTaskBuffer: (taskId) => ipcRenderer.invoke('task-get-buffer', taskId),
  getChatHistory: (taskId) => ipcRenderer.invoke('get-chat-history', taskId),
  setChatHistory: (taskId, messages) => ipcRenderer.invoke('set-chat-history', taskId, messages),
  resizePty: (taskId, cols, rows) => ipcRenderer.invoke('resize-pty', taskId, cols, rows),
  killTask: (taskId) => ipcRenderer.invoke('kill-task', taskId),
  onPtyData: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, taskId: string, data: string) => callback(taskId, data)
    ipcRenderer.on('pty-data', handler)
    return () => ipcRenderer.removeListener('pty-data', handler)
  },
  getProjectPath: () => ipcRenderer.invoke('get-project-path'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openTaskCreateWindow: () => ipcRenderer.invoke('open-task-create-window'),
  getTaskRuntimeMode: (taskId) => ipcRenderer.invoke('get-task-runtime-mode', taskId),
  acpSendAndStream: (taskId, prompt) => ipcRenderer.invoke('acp-send-and-stream', taskId, prompt),
  acpCancel: (sessionId) => ipcRenderer.invoke('acp-cancel', sessionId),
  acpRespondPermission: (sessionId, approved) => ipcRenderer.invoke('acp-respond-permission', sessionId, approved),
  acpCancelByTask: (taskId) => ipcRenderer.invoke('acp-cancel-by-task', taskId),
  getAcpTaskBusy: (taskId) => ipcRenderer.invoke('get-acp-task-busy', taskId),
  getAcpSessionId: (taskId) => ipcRenderer.invoke('get-acp-session-id', taskId),
  acpResumeSession: (taskId) => ipcRenderer.invoke('acp-resume-session', taskId),
  onAcpSessionUpdate: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, event: AcpFrontendEvent) => callback(event)
    ipcRenderer.on('acp-session-update', handler)
    return () => ipcRenderer.removeListener('acp-session-update', handler)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)