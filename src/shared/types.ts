export type TaskStatus = 'created' | 'running' | 'waiting_input' | 'completed' | 'interrupted'
export type AgentType = 'claude-code' | 'flow-cli' | 'hermes-agent'

export interface Task {
  id: string
  name: string
  description: string
  agent: AgentType
  workPath: string
  command: string
  interactions: string[]
  status: TaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  exitCode?: number | null
  runtimeMode?: 'legacy' | 'acp'
  /** ACP 会话 ID，持久化后用于 resumeSession 恢复上下文 */
  acpSessionId?: string | null
  lastError?: string
  runtimeReason?: string
  runtimeEndpoint?: string
}

export type CreateTaskInput = Omit<Task, 'id' | 'status' | 'startedAt' | 'finishedAt' | 'exitCode' | 'interactions' | 'command'>

export interface Column {
  id: TaskStatus
  title: string
  color: string
}