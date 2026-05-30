import { useState, useEffect, useRef } from 'react'
import type { Task } from '../../shared/types'
import type { AcpFrontendEvent } from '../../shared/acp'

interface TaskInteractionPanelProps {
  task?: Task
  collapsed: boolean
  width: number
  onToggle: () => void
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

function TaskInteractionPanel({ task, collapsed, width, onToggle }: TaskInteractionPanelProps) {
  const messageListRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  const [systemLogs, setSystemLogs] = useState<string[]>([])
  const systemLogRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isAcpBusy, setIsAcpBusy] = useState(false)

  const appendSystemLogs = (entries: string[]): void => {
    if (entries.length === 0) return
    setSystemLogs(prev => {
      const next = [...prev, ...entries]
      return next.length > 1000 ? next.slice(next.length - 1000) : next
    })
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

  const appendAssistantMessage = (raw: string): void => {
    const cleaned = sanitizeTerminalOutput(stripBackendMessages(raw)).trim()
    if (!cleaned) return
    setMessages(prev => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') {
        last.content = `${last.content}\n${cleaned}`.trim()
      } else {
        next.push({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'assistant',
          content: cleaned
        })
      }
      return next
    })
  }

  useEffect(() => {
    if (!task || collapsed) {
      setMessages([])
      setSystemLogs([])
      setIsAcpBusy(false)
      return
    }
    window.electronAPI.getTaskBuffer(task.id).then(buffer => {
      const joined = buffer.join('')
      const backend = extractBackendMessages(joined)
      setSystemLogs(backend)
      const cleaned = sanitizeTerminalOutput(stripBackendMessages(joined)).trim()
      if (cleaned) {
        setMessages([{
          id: `init-${task.id}`,
          role: 'assistant',
          content: cleaned
        }])
      } else {
        setMessages([])
      }
    })
  }, [task?.id, collapsed])

  useEffect(() => {
    if (!task || collapsed) return
    if (task.runtimeMode === 'acp') return
    const unsubscribe = window.electronAPI.onPtyData((taskId, data) => {
      if (taskId === task.id) {
        const backend = extractBackendMessages(data)
        appendSystemLogs(backend)
        appendAssistantMessage(data)
        if (task.runtimeMode === 'acp') {
          const cleanedChunk = sanitizeTerminalOutput(stripBackendMessages(data))
          if (cleanedChunk.trim()) {
            appendSystemLogs([`[acp-chunk] ${cleanedChunk.replace(/\n/g, '\\n')}`])
          }
        }
      }
    })

    return unsubscribe
  }, [task?.id, task?.runtimeMode, collapsed])

  useEffect(() => {
    if (!task || collapsed) return
    if (task.runtimeMode !== 'acp') return
    const unsubscribe = window.electronAPI.onAcpSessionUpdate((event: AcpFrontendEvent) => {
      if (event.taskId !== task.id) return
      if (event.type === 'sessionUpdate') {
        setIsAcpBusy(true)
        const chunk = event.chunk ?? ''
        appendAssistantMessage(chunk)
        const cleanedChunk = sanitizeTerminalOutput(stripBackendMessages(chunk))
        if (cleanedChunk.trim()) {
          appendSystemLogs([`[acp-chunk] ${cleanedChunk.replace(/\n/g, '\\n')}`])
        }
        return
      }
      if (event.type === 'permissionRequest') {
        setIsAcpBusy(false)
        appendSystemLogs([`[acp] permission/input requested`])
        return
      }
      if (event.type === 'sessionDone') {
        setIsAcpBusy(false)
        appendSystemLogs([`[acp] session done: ${event.exitCode ?? -1}`])
        return
      }
      if (event.type === 'sessionError') {
        setIsAcpBusy(false)
        appendSystemLogs([`[acp] session error: ${event.message ?? 'unknown'}`])
      }
    })
    return unsubscribe
  }, [task?.id, task?.runtimeMode, collapsed])

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
    setMessages(prev => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'user',
        content: text
      }
    ])
    try {
      if (task.runtimeMode === 'acp') {
        setIsAcpBusy(true)
        await window.electronAPI.acpSendAndStream(task.id, text)
      } else {
        await window.electronAPI.sendTaskInput(task.id, `${text}\n`)
      }
      setInput('')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('409') || message.includes('session is busy')) {
        appendSystemLogs(['[acp] session is busy，上一轮尚未完成'])
      } else {
        appendSystemLogs([`[acp] send failed: ${message}`])
      }
      setIsAcpBusy(false)
    }
  }

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
                  {systemLogs.length === 0 && <div className="interaction-empty">暂无系统日志</div>}
                  {systemLogs.map((line, idx) => (
                    <div key={`${idx}-${line}`} className="interaction-system-log-line">{line}</div>
                  ))}
                </div>
              </div>
              <div className="chat-messages" ref={messageListRef}>
                {messages.length === 0 && <div className="interaction-empty">等待 ACP 响应...</div>}
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`chat-row ${message.role === 'user' ? 'chat-row-user' : 'chat-row-assistant'}`}
                  >
                    {message.role === 'user' ? (
                      <div className="chat-bubble chat-bubble-user">{message.content}</div>
                    ) : (
                      <div className="chat-assistant-text">{message.content}</div>
                    )}
                  </div>
                ))}
              </div>
              <div className="interaction-input-row">
                <input
                  className="form-input interaction-input"
                  placeholder={isAcpBusy && task.runtimeMode === 'acp' ? 'ACP 正在处理上一条消息...' : '输入内容后回车或点击发送'}
                  value={input}
                  disabled={isAcpBusy && task.runtimeMode === 'acp'}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleSend()
                    }
                  }}
                />
                <button
                  className="btn-primary"
                  onClick={() => void handleSend()}
                  disabled={isAcpBusy && task.runtimeMode === 'acp'}
                >
                  {isAcpBusy && task.runtimeMode === 'acp' ? '处理中...' : '发送'}
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