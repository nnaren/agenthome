import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { Task } from '../../shared/types'
import '@xterm/xterm/css/xterm.css'

interface TaskInteractionPanelProps {
  task?: Task
  collapsed: boolean
  width: number
  onToggle: () => void
}

function TaskInteractionPanel({ task, collapsed, width, onToggle }: TaskInteractionPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [input, setInput] = useState('')

  const initTerminal = useCallback(() => {
    if (!terminalRef.current) return

    if (termRef.current) {
      termRef.current.dispose()
    }

    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', Menlo, Monaco, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        black: '#1e1e1e',
        brightBlack: '#3c3c3c',
        red: '#f44747',
        brightRed: '#f44747',
        green: '#4ec9b0',
        brightGreen: '#4ec9b0',
        yellow: '#dcdcaa',
        brightYellow: '#dcdcaa',
        blue: '#569cd6',
        brightBlue: '#569cd6',
        magenta: '#c586c0',
        brightMagenta: '#c586c0',
        cyan: '#9cdcfe',
        brightCyan: '#9cdcfe',
        white: '#d4d4d4',
        brightWhite: '#ffffff',
        cursor: '#ffffff'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    term.open(terminalRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Handle user input
    term.onData(data => {
      if (task) {
        window.electronAPI.sendTaskInput(task.id, data)
      }
    })

    // Handle resize
    const observer = new ResizeObserver(() => {
      try { fitAddon.fit() } catch {}
    })
    observer.observe(terminalRef.current)

    return () => observer.disconnect()
  }, [task?.id])

  useEffect(() => {
    if (collapsed || !task) {
      if (termRef.current) {
        termRef.current.dispose()
        termRef.current = null
      }
      return
    }

    const cleanup = initTerminal()

    // Load existing buffer
    window.electronAPI.getTaskBuffer(task.id).then(buffer => {
      if (termRef.current && buffer.length > 0) {
        termRef.current.write(buffer.join(''))
      }
    })

    return () => {
      cleanup?.()
      if (termRef.current) {
        termRef.current.dispose()
        termRef.current = null
      }
    }
  }, [task?.id, collapsed, initTerminal])

  // Listen for new pty data
  useEffect(() => {
    if (!task) return

    const unsubscribe = window.electronAPI.onPtyData((taskId, data) => {
      if (taskId === task.id && termRef.current) {
        termRef.current.write(data)
      }
    })

    return unsubscribe
  }, [task?.id])

  const handleSend = async () => {
    if (!task || !input.trim()) return
    await window.electronAPI.sendTaskInput(task.id, '\r')
    setInput('')
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
          <div className="interaction-title">集成终端</div>
          {!task && <div className="interaction-empty">点击左侧任务卡打开终端</div>}
          {task && (
            <>
              <div className="interaction-task-name">{task.name}</div>
              <div className="interaction-terminal" ref={terminalRef} />
            </>
          )}
        </div>
      )}
    </aside>
  )
}

export default TaskInteractionPanel