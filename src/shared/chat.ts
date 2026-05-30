export interface ChatThoughtRecord {
  content: string
  startedAt: number
  endedAt?: number
  expanded: boolean
}

export interface ToolCallRecord {
  toolCallId: string
  title: string
  status?: string
  kind?: string
  rawInput?: unknown
  rawOutput?: unknown
}

/** 助手消息片段顺序（think / tool 按到达时间交错） */
export type MessageSegment =
  | { type: 'thought'; thoughtIndex: number }
  | { type: 'tool'; toolCallId: string }

export interface ChatMessageRecord {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** @deprecated 使用 thoughts */
  thought?: ChatThoughtRecord
  /** 多段思考（工具调用前后各一段等） */
  thoughts?: ChatThoughtRecord[]
  /** 片段展示顺序 */
  segments?: MessageSegment[]
  toolCalls?: ToolCallRecord[]
}
