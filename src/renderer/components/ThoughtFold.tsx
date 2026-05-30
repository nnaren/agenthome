interface ThoughtFoldProps {
  content: string
  startedAt: number
  endedAt?: number
  expanded: boolean
  onToggle: () => void
}

function formatDurationMs(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000))
  return `${sec}s`
}

function ThoughtFold({
  content,
  startedAt,
  endedAt,
  expanded,
  onToggle
}: ThoughtFoldProps) {
  const hasContent = content.trim().length > 0
  const label = endedAt
    ? `Thought for ${formatDurationMs(endedAt - startedAt)}`
    : 'Thinking...'

  return (
    <div className="thought-fold">
      <button
        type="button"
        className="thought-fold-trigger"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className={`thought-fold-chevron ${expanded ? 'expanded' : ''}`} aria-hidden>
          ›
        </span>
        <span className="thought-fold-label">{label}</span>
      </button>
      {expanded && hasContent && (
        <div className="thought-fold-body">{content}</div>
      )}
    </div>
  )
}

export default ThoughtFold
