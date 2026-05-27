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
}

export type CreateTaskInput = Omit<Task, 'id' | 'status' | 'startedAt' | 'finishedAt' | 'exitCode' | 'interactions' | 'command'>

export interface Column {
  id: TaskStatus
  title: string
  color: string
}