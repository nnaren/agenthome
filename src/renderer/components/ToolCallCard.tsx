import { useState } from 'react'
import type { ToolCallRecord } from '../../shared/chat'
import { buildToolCallDisplay } from '../utils/toolCallDisplay'

interface ToolCallCardProps {
  toolCall: ToolCallRecord
}

function statusHint(status?: string): string | null {
  if (status === 'in_progress') return '执行中…'
  if (status === 'pending') return '等待执行…'
  if (status === 'failed') return '执行失败'
  return null
}

function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const display = buildToolCallDisplay(toolCall)
  const status = toolCall.status ?? 'pending'
  const [expanded, setExpanded] = useState(false)
  const hint = statusHint(status)
  const showCmd = Boolean(
    display.commandLine
    && display.commandLine !== display.foldLabel
    && !display.foldLabel.includes(display.commandLine)
  )
  const bodyText = display.result || hint
  const hasBody = Boolean(showCmd || bodyText)

  return (
    <div className={`thought-fold tool-fold tool-fold-${status}`}>
      <button
        type="button"
        className="thought-fold-trigger"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`thought-fold-chevron ${expanded ? 'expanded' : ''}`} aria-hidden>
          ›
        </span>
        <span className="thought-fold-label">{display.foldLabel}</span>
      </button>
      {expanded && hasBody && (
        <div className="thought-fold-body tool-fold-body">
          {showCmd && (
            <div className="tool-fold-cmd">{display.commandLine}</div>
          )}
          {bodyText && <div className="tool-fold-result">{bodyText}</div>}
        </div>
      )}
    </div>
  )
}

export default ToolCallCard
