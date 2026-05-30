import { useState, useEffect, useRef, useCallback } from 'react'
import type { ChatMessageRecord, MessageSegment, ToolCallRecord } from '../../shared/chat'
import ToolCallCard from './ToolCallCard'
import type { Task } from '../../shared/types'
import type { AcpFrontendEvent } from '../../shared/acp'
import ThoughtFold from './ThoughtFold'
import AssistantMessageBody from './AssistantMessageBody'
import {
  appendToolSegment,
  applyMessageStreamChunk,
  applyThoughtStreamChunk,
  extractMessageBodyWithoutThink,
  finalizeAllThoughts,
  rebuildSegments,
  type ThoughtBlockState
} from '../utils/thinkStream'
import {
  ACP_TOOL_CALL_LOG_MARKER,
  ACP_TOOL_CALL_UPDATE_LOG_MARKER,
  escapeChunkForLog,
  extractThinkingFromTags,
  formatToolCallLogLine,
  formatToolCallUpdateLogLine,
  normalizeStreamChunk,
  prepareMessageForDisplay
} from '../utils/streamText'

interface TaskInteractionPanelProps {
  task?: Task
  collapsed: boolean
  width: number
  onToggle: () => void
}

type ThoughtBlock = ThoughtBlockState

interface ChatMessage extends ChatMessageRecord {
  streamRaw?: string
  materializedThinkCount?: number
}

function getThoughtList(msg: ChatMessage): ThoughtBlock[] {
  if (msg.thoughts && msg.thoughts.length > 0) return msg.thoughts
  if (msg.thought) return [msg.thought]
  return []
}

function finalizeOpenThoughts(thoughts: ThoughtBlock[]): ThoughtBlock[] {
  return finalizeAllThoughts(thoughts)
}

function getSegments(msg: ChatMessage): MessageSegment[] {
  if (msg.segments && msg.segments.length > 0) return msg.segments
  const toolIds = (msg.toolCalls ?? []).map((t) => t.toolCallId)
  return rebuildSegments(getThoughtList(msg), toolIds)
}

function serializeMessages(messages: ChatMessage[]): ChatMessageRecord[] {
  return messages.map(({ streamRaw: _s, materializedThinkCount: _m, thought, thoughts, ...rest }) => {
    const list =
      thoughts && thoughts.length > 0
        ? thoughts
        : thought
          ? [thought]
          : undefined
    return {
      ...rest,
      segments: rest.segments?.map((s) => ({ ...s })),
      thoughts: list?.map((t) => ({ ...t })),
      thought: undefined
    }
  })
}

/** 任务启动时用 description 补用户气泡（创建/拖入运行时尚未走交互区发送） */
const SYSTEM_LOG_MAX = 2000
const CHUNK_LOG_MARKER = '[acp] chunk output: '

function formatLogTimestamp(date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function stampLogLine(message: string, at = new Date()): string {
  return `[${formatLogTimestamp(at)}] ${message}`
}

function isChunkLogLine(line: string): boolean {
  return line.includes(CHUNK_LOG_MARKER)
}

function isToolLogLine(line: string): boolean {
  return line.includes(ACP_TOOL_CALL_LOG_MARKER) || line.includes(ACP_TOOL_CALL_UPDATE_LOG_MARKER)
}

function systemLogLineClass(line: string): string {
  if (isChunkLogLine(line)) return ' interaction-chunk-log-line'
  if (isToolLogLine(line)) return ' interaction-tool-log-line'
  return ''
}

function logLineBody(line: string): string {
  return line.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '')
}

function withUserBubble(msgs: ChatMessage[], currentTask: Task): ChatMessage[] {
  const desc = currentTask.description?.trim()
  if (!desc) return msgs
  if (msgs.some((m) => m.role === 'user')) return msgs
  return [
    { id: `user-init-${currentTask.id}`, role: 'user', content: desc },
    ...msgs
  ]
}

function TaskInteractionPanel({ task, collapsed, width, onToggle }: TaskInteractionPanelProps) {
  const messageListRef = useRef<HTMLDivElement>(null)
  const messagesByTaskRef = useRef<Map<string, ChatMessage[]>>(new Map())
  const messagesRef = useRef<ChatMessage[]>([])
  const activeTaskIdRef = useRef<string | undefined>()
  const [input, setInput] = useState('')
  const [systemLogs, setSystemLogs] = useState<string[]>([])
  const systemLogsByTaskRef = useRef<Map<string, string[]>>(new Map())
  const systemLogRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [acpBusyByTask, setAcpBusyByTask] = useState<Record<string, boolean>>({})
  const acpPermissionByTaskRef = useRef<Map<string, { sessionId: string; message: string }>>(new Map())
  const acpSessionIdByTaskRef = useRef<Map<string, string>>(new Map())
  const [acpSessionId, setAcpSessionId] = useState<string | null>(null)
  const [acpPermission, setAcpPermission] = useState<{ sessionId: string; message: string } | null>(null)

  const setTaskSessionId = useCallback((taskId: string, sessionId: string | null): void => {
    if (sessionId) {
      acpSessionIdByTaskRef.current.set(taskId, sessionId)
    } else {
      acpSessionIdByTaskRef.current.delete(taskId)
    }
    if (taskId === activeTaskIdRef.current) {
      setAcpSessionId(sessionId)
    }
  }, [])
  const isAcpBusy = task ? (acpBusyByTask[task.id] ?? false) : false
  const isWaitingPermission = Boolean(acpPermission)

  const persistChatHistory = useCallback((taskId: string, next: ChatMessage[]) => {
    const serialized = serializeMessages(next)
    messagesByTaskRef.current.set(taskId, next)
    void window.electronAPI.setChatHistory(taskId, serialized)
  }, [])

  const appendSystemLogsForTask = useCallback((taskId: string, entries: string[]): void => {
    if (entries.length === 0) return
    const stamped = entries.map((entry) => stampLogLine(entry))
    const prev = systemLogsByTaskRef.current.get(taskId) ?? []
    const next = [...prev, ...stamped]
    const trimmed = next.length > SYSTEM_LOG_MAX ? next.slice(-SYSTEM_LOG_MAX) : next
    systemLogsByTaskRef.current.set(taskId, trimmed)
    if (taskId === activeTaskIdRef.current) {
      setSystemLogs(trimmed)
    }
  }, [])

  const logAcpChunk = (taskId: string, chunk: string): void => {
    if (!chunk) return
    appendSystemLogsForTask(taskId, [`${CHUNK_LOG_MARKER}${escapeChunkForLog(chunk)}`])
  }

  const stripBackendMessages = (text: string): string => {
    return text
      .replace(/\[(system|acp)\][^\r\n]*/g, '')
      .replace(/\r?\n\s*\r?\n/g, '\n')
  }

  const sanitizeTerminalOutput = (text: string): string => {
    return text
      .replace(/Warning:\s*no stdin data received[\s\S]*?wait longer\.\s*/gi, '')
      .replace(/\n[ \t]{12,}/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
  }

  const extractBackendMessages = (text: string): string[] => {
    const matches = text.match(/\[(system|acp)\][^\r\n]*/g)
    return matches ?? []
  }

  const ensureAssistantTurn = (prev: ChatMessage[]): { next: ChatMessage[]; index: number } => {
    const last = prev[prev.length - 1]
    if (last?.role === 'assistant') {
      return { next: [...prev], index: prev.length - 1 }
    }
    const next = [
      ...prev,
      {
        id: `acp-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant' as const,
        content: ''
      }
    ]
    return { next, index: next.length - 1 }
  }

  const flushStreamBody = (msg: ChatMessage): string => {
    if (!msg.streamRaw) return msg.content
    const body = extractMessageBodyWithoutThink(msg.streamRaw)
    if (!body) return msg.content
    return body.length >= msg.content.length ? body : msg.content
  }

  const flushThoughtsFromStream = (msg: ChatMessage): ThoughtBlock[] => {
    return finalizeOpenThoughts(getThoughtList(msg))
  }

  const finalizeLastThought = (prev: ChatMessage[]): ChatMessage[] => {
    const last = prev[prev.length - 1]
    if (!last || last.role !== 'assistant') return prev
    const next = [...prev]
    const { streamRaw: _raw, thought: _t, materializedThinkCount: _mc, ...rest } = last
    const content = prepareMessageForDisplay(
      last.streamRaw
        ? extractMessageBodyWithoutThink(last.streamRaw)
        : flushStreamBody(last)
    )
    const thoughts = flushThoughtsFromStream(last)
    next[next.length - 1] = {
      ...rest,
      content,
      segments: last.segments,
      ...(thoughts.length > 0 ? { thoughts } : {})
    }
    return next
  }

  const appendAssistantMessage = (raw: string): void => {
    const cleaned = prepareMessageForDisplay(
      sanitizeTerminalOutput(stripBackendMessages(raw))
    ).trim()
    if (!cleaned) return
    const { thought, message } = extractThinkingFromTags(cleaned)
    if (!message && !thought) return
    setMessages(prev => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') {
        next[next.length - 1] = {
          ...last,
          content: message ? `${last.content}\n${message}`.trim() : last.content,
          thoughts: thought
            ? [
                ...finalizeOpenThoughts(getThoughtList(last)),
                {
                  content: thought,
                  startedAt: Date.now(),
                  endedAt: Date.now(),
                  expanded: false
                }
              ]
            : getThoughtList(last),
          thought: undefined
        }
      } else {
        next.push({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'assistant',
          content: message,
          thoughts: thought
            ? [{
                content: thought,
                startedAt: Date.now(),
                endedAt: Date.now(),
                expanded: false
              }]
            : undefined,
          thought: undefined
        })
      }
      return next
    })
  }

  const applyAcpChunkToMessages = (
    prev: ChatMessage[],
    chunk: string,
    kind: 'message' | 'thought'
  ): ChatMessage[] => {
    const piece = normalizeStreamChunk(chunk)
    if (!piece) return prev
    const { next, index } = ensureAssistantTurn(prev)
    const current = next[index]
    const base = {
      streamRaw: current.streamRaw ?? '',
      thoughts: getThoughtList(current),
      segments: getSegments(current),
      materializedThinkCount: current.materializedThinkCount ?? 0,
      content: current.content
    }

    if (kind === 'thought') {
      const applied = applyThoughtStreamChunk(base, piece)
      next[index] = {
        ...current,
        ...applied,
        thought: undefined
      }
      return next
    }

    const applied = applyMessageStreamChunk(base, piece)
    next[index] = {
      ...current,
      ...applied,
      thought: undefined
    }
    return next
  }

  const applyToolCall = (prev: ChatMessage[], toolCall: ToolCallRecord): ChatMessage[] => {
    const { next, index } = ensureAssistantTurn(prev)
    const current = next[index]
    const existing = current.toolCalls ?? []
    if (existing.some((t) => t.toolCallId === toolCall.toolCallId)) return next
    const thoughts = finalizeOpenThoughts(getThoughtList(current))
    const segments = appendToolSegment(getSegments(current), toolCall.toolCallId)
    next[index] = {
      ...current,
      thoughts,
      segments,
      thought: undefined,
      toolCalls: [...existing, toolCall]
    }
    return next
  }

  const mergeToolCallRecord = (
    base: ToolCallRecord,
    patch: Partial<ToolCallRecord> & { toolCallId: string }
  ): ToolCallRecord => {
    const next: ToolCallRecord = { ...base }
    if (patch.title != null && patch.title !== '') next.title = patch.title
    if (patch.status != null) next.status = patch.status
    if (patch.kind != null) next.kind = patch.kind
    if (patch.rawInput !== undefined) next.rawInput = patch.rawInput
    if (patch.rawOutput !== undefined) next.rawOutput = patch.rawOutput
    return next
  }

  const applyToolCallUpdate = (
    prev: ChatMessage[],
    update: Partial<ToolCallRecord> & { toolCallId: string }
  ): ChatMessage[] => {
    const { next, index } = ensureAssistantTurn(prev)
    const current = next[index]
    const existing = current.toolCalls ?? []
    const idx = existing.findIndex((t) => t.toolCallId === update.toolCallId)
    if (idx >= 0) {
      const merged = mergeToolCallRecord(existing[idx], update)
      const toolCalls = [...existing]
      toolCalls[idx] = merged
      next[index] = { ...current, toolCalls }
      return next
    }
    next[index] = {
      ...current,
      toolCalls: [
        ...existing,
        {
          toolCallId: update.toolCallId,
          title: update.title ?? '',
          status: update.status,
          kind: update.kind,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput
        }
      ]
    }
    return next
  }

  const updateTaskMessages = (
    taskId: string,
    updater: (prev: ChatMessage[]) => ChatMessage[]
  ): void => {
    if (taskId === activeTaskIdRef.current) {
      setMessages((prev) => {
        const next = updater(prev)
        messagesByTaskRef.current.set(taskId, next)
        return next
      })
      return
    }
    const prev = messagesByTaskRef.current.get(taskId) ?? []
    const next = updater(prev)
    messagesByTaskRef.current.set(taskId, next)
    void window.electronAPI.setChatHistory(taskId, serializeMessages(next))
  }

  const toggleThoughtExpanded = (messageId: string, thoughtIndex: number): void => {
    setMessages((prev) => prev.map((msg) => {
      if (msg.id !== messageId) return msg
      const thoughts = getThoughtList(msg)
      if (!thoughts[thoughtIndex]) return msg
      const nextThoughts = [...thoughts]
      nextThoughts[thoughtIndex] = {
        ...nextThoughts[thoughtIndex],
        expanded: !nextThoughts[thoughtIndex].expanded
      }
      return { ...msg, thoughts: nextThoughts, thought: undefined }
    }))
  }

  messagesRef.current = messages

  useEffect(() => {
    if (!task || collapsed) {
      setMessages([])
      setSystemLogs([])
      activeTaskIdRef.current = undefined
      return
    }

    const previousTaskId = activeTaskIdRef.current
    if (previousTaskId && previousTaskId !== task.id && messagesRef.current.length > 0) {
      persistChatHistory(previousTaskId, messagesRef.current)
    }
    activeTaskIdRef.current = task.id
    setAcpPermission(acpPermissionByTaskRef.current.get(task.id) ?? null)
    setAcpSessionId(acpSessionIdByTaskRef.current.get(task.id) ?? null)

    let cancelled = false

    void window.electronAPI.getAcpTaskBusy(task.id).then(({ busy }) => {
      if (!cancelled) {
        setAcpBusyByTask((prev) => ({ ...prev, [task.id]: busy }))
      }
    })
    if (task.runtimeMode === 'acp') {
      void window.electronAPI.getAcpSessionId(task.id).then(({ sessionId }) => {
        if (!cancelled && sessionId) setTaskSessionId(task.id, sessionId)
      })
    }
    const load = async (): Promise<void> => {
      const buffer = await window.electronAPI.getTaskBuffer(task.id)
      if (cancelled) return
      const joined = buffer.join('')
      const cachedLogs = systemLogsByTaskRef.current.get(task.id) ?? []
      const seenBodies = new Set(cachedLogs.map(logLineBody))
      const newFromBuffer = extractBackendMessages(joined)
        .filter((line) => !seenBodies.has(line))
        .map((line) => stampLogLine(line))
      const mergedLogs =
        cachedLogs.length > 0 || newFromBuffer.length > 0
          ? [...cachedLogs, ...newFromBuffer]
          : []
      const trimmedLogs =
        mergedLogs.length > SYSTEM_LOG_MAX
          ? mergedLogs.slice(-SYSTEM_LOG_MAX)
          : mergedLogs
      systemLogsByTaskRef.current.set(task.id, trimmedLogs)
      setSystemLogs(trimmedLogs)

      const memoryCached = messagesByTaskRef.current.get(task.id)
      if (memoryCached && memoryCached.length > 0) {
        const next = withUserBubble(memoryCached, task)
        messagesByTaskRef.current.set(task.id, next)
        setMessages(next)
        if (next.length !== memoryCached.length) {
          void window.electronAPI.setChatHistory(task.id, serializeMessages(next))
        }
        return
      }

      const stored = await window.electronAPI.getChatHistory(task.id)
      if (cancelled) return
      if (stored.length > 0) {
        const restored: ChatMessage[] = withUserBubble(
          stored.map((m) => ({
            ...m,
            thoughts: m.thoughts?.map((t) => ({ ...t, expanded: false }))
              ?? (m.thought ? [{ ...m.thought, expanded: false }] : undefined),
            thought: undefined
          })),
          task
        )
        messagesByTaskRef.current.set(task.id, restored)
        setMessages(restored)
        if (restored.length !== stored.length) {
          void window.electronAPI.setChatHistory(task.id, serializeMessages(restored))
        }
        return
      }

      const raw = prepareMessageForDisplay(
        sanitizeTerminalOutput(stripBackendMessages(joined))
      )
      const { thought, message } = extractThinkingFromTags(raw)
      let initial: ChatMessage[] = []
      if (message || thought) {
        initial = [{
          id: `init-${task.id}`,
          role: 'assistant',
          content: message,
          thoughts: thought
            ? [{
                content: thought,
                startedAt: Date.now(),
                endedAt: Date.now(),
                expanded: false
              }]
            : undefined,
          thought: undefined
        }]
      }
      const next = withUserBubble(initial, task)
      messagesByTaskRef.current.set(task.id, next)
      setMessages(next)
      if (next.length > 0) {
        void window.electronAPI.setChatHistory(task.id, serializeMessages(next))
      }
    }

    void load()
    return () => { cancelled = true }
  }, [task?.id, task?.status, task?.description, collapsed])

  useEffect(() => {
    if (!task?.id || collapsed || messages.length === 0) return
    const taskId = task.id
    const timer = window.setTimeout(() => {
      if (activeTaskIdRef.current !== taskId) return
      persistChatHistory(taskId, messages)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [messages, task?.id, collapsed, persistChatHistory])

  useEffect(() => {
    if (!task || collapsed) return
    if (task.runtimeMode === 'acp') return
    const unsubscribe = window.electronAPI.onPtyData((taskId, data) => {
      if (taskId === task.id) {
        const backend = extractBackendMessages(data)
        appendSystemLogsForTask(taskId, backend)
        appendAssistantMessage(data)
      }
    })

    return unsubscribe
  }, [task?.id, task?.runtimeMode, collapsed, appendSystemLogsForTask])

  const clearAcpPermission = useCallback((taskId: string): void => {
    acpPermissionByTaskRef.current.delete(taskId)
    if (taskId === activeTaskIdRef.current) {
      setAcpPermission(null)
    }
  }, [])

  useEffect(() => {
    if (collapsed) return
    const unsubscribe = window.electronAPI.onAcpSessionUpdate((event: AcpFrontendEvent) => {
      const taskId = event.taskId
      if (event.sessionId) {
        setTaskSessionId(taskId, event.sessionId)
      }
      if (event.type === 'sessionUpdate') {
        if (acpPermissionByTaskRef.current.has(taskId)) {
          clearAcpPermission(taskId)
        }
        setAcpBusyByTask((prev) => ({ ...prev, [taskId]: true }))
        const kind = event.chunkKind ?? 'message'
        const raw = event.chunk ?? ''
        logAcpChunk(taskId, raw)
        updateTaskMessages(taskId, (prev) => applyAcpChunkToMessages(prev, raw, kind))
        return
      }
      if (event.type === 'toolCall' && event.toolCall) {
        setAcpBusyByTask((prev) => ({ ...prev, [taskId]: true }))
        appendSystemLogsForTask(taskId, [formatToolCallLogLine(event.toolCall)])
        updateTaskMessages(taskId, (prev) => applyToolCall(prev, event.toolCall!))
        return
      }
      if (event.type === 'toolCallUpdate' && event.toolCallUpdate) {
        setAcpBusyByTask((prev) => ({ ...prev, [taskId]: true }))
        appendSystemLogsForTask(taskId, [formatToolCallUpdateLogLine(event.toolCallUpdate)])
        updateTaskMessages(taskId, (prev) => applyToolCallUpdate(prev, event.toolCallUpdate!))
        return
      }
      if (event.type === 'permissionRequest') {
        setAcpBusyByTask((prev) => ({ ...prev, [taskId]: false }))
        const pending = {
          sessionId: event.sessionId,
          message: event.message ?? '需要批准工具调用'
        }
        acpPermissionByTaskRef.current.set(taskId, pending)
        if (taskId === activeTaskIdRef.current) {
          setAcpPermission(pending)
        }
        appendSystemLogsForTask(taskId, [
          `[acp] permission/input requested: ${pending.message}`
        ])
        updateTaskMessages(taskId, (prev) => finalizeLastThought(prev))
        return
      }
      if (event.type === 'sessionDone') {
        clearAcpPermission(taskId)
        if (event.sessionId) {
          setTaskSessionId(taskId, event.sessionId)
        }
        setAcpBusyByTask((prev) => ({ ...prev, [taskId]: false }))
        updateTaskMessages(taskId, (prev) => {
          const next = finalizeLastThought(prev)
          persistChatHistory(taskId, next)
          return next
        })
        appendSystemLogsForTask(taskId, [`[acp] session done: ${event.exitCode ?? -1}`])
        return
      }
      if (event.type === 'sessionError') {
        clearAcpPermission(taskId)
        setAcpBusyByTask((prev) => ({ ...prev, [taskId]: false }))
        updateTaskMessages(taskId, (prev) => finalizeLastThought(prev))
        appendSystemLogsForTask(taskId, [`[acp] session error: ${event.message ?? 'unknown'}`])
      }
    })
    return unsubscribe
  }, [collapsed, persistChatHistory, appendSystemLogsForTask, clearAcpPermission, setTaskSessionId])

  useEffect(() => {
    if (systemLogRef.current) {
      systemLogRef.current.scrollTop = systemLogRef.current.scrollHeight
    }
  }, [systemLogs])

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = async () => {
    if (!task || !input.trim()) return
    const text = input.trim()
    appendSystemLogsForTask(task.id, [`[acp] user prompt: ${text}`])
    setMessages(prev => {
      const next: ChatMessage[] = [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'user',
          content: text
        }
      ]
      persistChatHistory(task.id, next)
      return next
    })
    try {
      if (task.runtimeMode === 'acp') {
        setAcpBusyByTask((prev) => ({ ...prev, [task.id]: true }))
        const result = await window.electronAPI.acpSendAndStream(task.id, text)
        if (result.sessionId) {
          setTaskSessionId(task.id, result.sessionId)
        }
        if (!result.ok) {
          setAcpBusyByTask((prev) => ({ ...prev, [task.id]: false }))
          appendSystemLogsForTask(task.id, ['[acp] session is busy，上一轮尚未完成'])
        }
      } else {
        await window.electronAPI.sendTaskInput(task.id, `${text}\n`)
      }
      setInput('')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendSystemLogsForTask(task.id, [`[acp] send failed: ${message}`])
      setAcpBusyByTask((prev) => ({ ...prev, [task.id]: false }))
    }
  }

  const handleCancelAcp = async (): Promise<void> => {
    if (!task) return
    if (acpPermission) {
      await window.electronAPI.acpRespondPermission(acpPermission.sessionId, false)
      clearAcpPermission(task.id)
    }
    await window.electronAPI.acpCancelByTask(task.id)
    setAcpBusyByTask((prev) => ({ ...prev, [task.id]: false }))
    appendSystemLogsForTask(task.id, ['[acp] 已取消当前提问（会话保留，可继续输入）'])
  }

  const handleRespondPermission = async (approved: boolean): Promise<void> => {
    if (!task || !acpPermission) return
    const { sessionId } = acpPermission
    clearAcpPermission(task.id)
    appendSystemLogsForTask(
      task.id,
      [approved ? '[acp] permission approved' : '[acp] permission denied']
    )
    setAcpBusyByTask((prev) => ({ ...prev, [task.id]: true }))
    await window.electronAPI.acpRespondPermission(sessionId, approved)
    if (!approved) {
      setAcpBusyByTask((prev) => ({ ...prev, [task.id]: false }))
    }
  }

  useEffect(() => {
    if (!task || collapsed || task.runtimeMode !== 'acp') return
    if (!isAcpBusy && !isWaitingPermission) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      e.preventDefault()
      void handleCancelAcp()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [task?.id, task?.runtimeMode, collapsed, isAcpBusy, isWaitingPermission])

  return (
    <aside
      className={`interaction-panel ${collapsed ? 'collapsed' : ''}`}
      style={collapsed ? undefined : { width: `${width}px` }}
    >
      <button className="interaction-toggle" onClick={onToggle}>
        {collapsed ? '展开终端' : '收起终端'}
      </button>
      {!collapsed && (
        <div className="interaction-content">
          {!task && <div className="interaction-empty">点击左侧任务卡开始交互</div>}
          {task && (
            <>
              <div className="interaction-system-log-wrap">
                <div className="interaction-system-log-title">系统日志</div>
                <div className="interaction-system-log" ref={systemLogRef}>
                  {systemLogs.length === 0 && (
                    <div className="interaction-empty">暂无系统日志</div>
                  )}
                  {systemLogs.map((line, idx) => (
                    <div
                      key={`${idx}-${line.slice(0, 48)}`}
                      className={`interaction-system-log-line${systemLogLineClass(line)}`}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </div>
              <div className="interaction-session-bar">
                <div className="interaction-session-row">
                  <span className="interaction-session-label">任务</span>
                  <span className="interaction-session-value" title={task.name}>
                    {task.name || '(未命名任务)'}
                  </span>
                </div>
                <div className="interaction-session-row">
                  <span className="interaction-session-label">Session</span>
                  <span
                    className="interaction-session-value interaction-session-id"
                    title={acpSessionId ?? undefined}
                  >
                    {task.runtimeMode === 'acp'
                      ? (acpSessionId ?? '—')
                      : '—（终端模式）'}
                  </span>
                </div>
              </div>
              <div className="chat-messages" ref={messageListRef}>
                {messages.length === 0 && <div className="interaction-empty">等待 ACP 响应...</div>}
                {messages.map((message) => {
                  const showAssistantBody =
                    message.role === 'assistant' && prepareMessageForDisplay(message.content)
                  return (
                  <div
                    key={message.id}
                    className={`chat-row ${message.role === 'user' ? 'chat-row-user' : 'chat-row-assistant'}`}
                  >
                    {message.role === 'user' ? (
                      <div className="chat-bubble chat-bubble-user">{message.content}</div>
                    ) : (
                      <div className="chat-assistant-block">
                        {(() => {
                          const thoughtBlocks = getThoughtList(message)
                          const toolCalls = message.toolCalls ?? []
                          const order = getSegments(message)
                          return order.map((seg) => {
                            if (seg.type === 'thought') {
                              const tb = thoughtBlocks[seg.thoughtIndex]
                              if (!tb) return null
                              return (
                                <ThoughtFold
                                  key={`${message.id}-thought-${seg.thoughtIndex}`}
                                  content={prepareMessageForDisplay(tb.content)}
                                  startedAt={tb.startedAt}
                                  endedAt={tb.endedAt}
                                  expanded={tb.expanded}
                                  onToggle={() => toggleThoughtExpanded(message.id, seg.thoughtIndex)}
                                />
                              )
                            }
                            const tc = toolCalls.find((t) => t.toolCallId === seg.toolCallId)
                            if (!tc) return null
                            return (
                              <ToolCallCard key={tc.toolCallId} toolCall={tc} />
                            )
                          })
                        })()}
                        {showAssistantBody && (
                          <AssistantMessageBody content={message.content} />
                        )}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
              {isWaitingPermission && task.runtimeMode === 'acp' && (
                <div className="acp-permission-banner">
                  <div className="acp-permission-message">
                    需要批准工具调用：{acpPermission?.message}
                  </div>
                  <div className="acp-permission-actions">
                    <button
                      type="button"
                      className="btn-primary acp-permission-approve"
                      onClick={() => void handleRespondPermission(true)}
                    >
                      允许
                    </button>
                    <button
                      type="button"
                      className="btn-primary acp-permission-deny"
                      onClick={() => void handleRespondPermission(false)}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              )}
              <div className="interaction-input-row">
                <input
                  className="form-input interaction-input"
                  placeholder={
                    isWaitingPermission && task.runtimeMode === 'acp'
                      ? '请先批准或拒绝上方的工具权限请求'
                      : isAcpBusy && task.runtimeMode === 'acp'
                        ? 'ACP 正在处理上一条消息...'
                        : '输入内容后回车或点击发送'
                  }
                  value={input}
                  disabled={
                    task.runtimeMode === 'acp' && (isAcpBusy || isWaitingPermission)
                  }
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleSend()
                    }
                  }}
                />
                {(isAcpBusy || isWaitingPermission) && task.runtimeMode === 'acp' && (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ background: '#6c757d' }}
                    onClick={() => void handleCancelAcp()}
                  >
                    停止 (Esc)
                  </button>
                )}
                <button
                  className="btn-primary"
                  onClick={() => void handleSend()}
                  disabled={
                    task.runtimeMode === 'acp' && (isAcpBusy || isWaitingPermission)
                  }
                >
                  {isWaitingPermission && task.runtimeMode === 'acp'
                    ? '等待批准'
                    : isAcpBusy && task.runtimeMode === 'acp'
                      ? '处理中...'
                      : '发送'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  )
}

export default TaskInteractionPanel
