import type { ToolCallRecord } from '../../shared/chat'

export interface ToolCallDisplay {
  /** 折叠标题：过去式工具名 + 参数，如 Read README.md / Listed test3 */
  foldLabel: string
  commandLine: string
  result: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

function formatLineRange(start: unknown, end: unknown): string {
  const s = typeof start === 'number' ? start : Number(start)
  const e = typeof end === 'number' ? end : Number(end)
  if (!Number.isNaN(s) && !Number.isNaN(e)) return ` L${s}-${e}`
  if (!Number.isNaN(s)) return ` L${s}`
  return ''
}

function formatPayload(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatToolOutput(rawOutput: unknown): string {
  if (rawOutput == null) return ''
  if (typeof rawOutput === 'string') return rawOutput
  const record = asRecord(rawOutput)
  if (record) {
    const text = pickString(record, ['text', 'output', 'stdout', 'content', 'message'])
    if (text) return text
    const nested = record.content
    if (Array.isArray(nested)) {
      const parts = nested
        .map((item) => {
          const block = asRecord(item)
          if (!block) return ''
          if (block.type === 'text' && typeof block.text === 'string') return block.text
          return ''
        })
        .filter(Boolean)
      if (parts.length > 0) return parts.join('\n')
    }
  }
  return formatPayload(rawOutput)
}

function isListLike(kind: string, title: string): boolean {
  return (
    kind === 'search'
    || kind === 'fetch'
    || /list|listed|列目录|列出|ls\b|dir/i.test(title)
  )
}

function isReadLike(kind: string, title: string): boolean {
  return kind === 'read' || /read|读取|查看.*文件|打开文件/i.test(title)
}

function isExecuteLike(kind: string, title: string): boolean {
  return kind === 'execute' || /exec|run|command|shell|bash|命令|执行/i.test(title)
}

function listedTargetFromCommand(command: string, fallbackPath: string): string {
  const trimmed = command.trim()
  if (!trimmed.startsWith('ls')) {
    return fallbackPath ? basename(fallbackPath) || fallbackPath : '.'
  }
  const args = trimmed.replace(/^ls\s+/, '').trim()
  if (!args || args.startsWith('-')) {
    return fallbackPath ? basename(fallbackPath) || fallbackPath : '.'
  }
  const pathArg = args.split(/\s+/).find((a) => !a.startsWith('-'))
  return pathArg ? basename(pathArg) || pathArg : (fallbackPath ? basename(fallbackPath) || fallbackPath : '.')
}

/** 工具名过去式（用于折叠标题） */
function pastTenseVerb(kind: string, title: string, toolHint: string): string {
  const verbs: Record<string, string> = {
    read: 'Read',
    edit: 'Edited',
    delete: 'Deleted',
    move: 'Moved',
    search: 'Listed',
    fetch: 'Fetched',
    execute: 'Ran',
    think: 'Thought'
  }
  if (verbs[kind]) return verbs[kind]
  if (isListLike(kind, title) || toolHint === 'ls') return 'Listed'
  if (isReadLike(kind, title)) return 'Read'
  if (isExecuteLike(kind, title)) return 'Ran'
  if (toolHint && toolHint !== 'tool') {
    const lower = toolHint.toLowerCase()
    if (lower === 'ls') return 'Listed'
    return toolHint.charAt(0).toUpperCase() + toolHint.slice(1)
  }
  return 'Called'
}

function parseTitleVerbParam(title: string): { verb: string; param: string } | null {
  const m = title.match(/^(Read|Listed|List|Ran|Execute|Edited|Deleted|Search)\s+(.+)$/i)
  if (!m) return null
  const name = m[1].toLowerCase()
  const verb = name === 'list' ? 'Listed' : name === 'read' ? 'Read' : name === 'ran' ? 'Ran' : m[1]
  return { verb, param: m[2].trim() }
}

function isGenericToolTitle(title: string): boolean {
  return !title || /^tool$/i.test(title)
}

export function buildToolCallDisplay(toolCall: ToolCallRecord): ToolCallDisplay {
  const input = asRecord(toolCall.rawInput)
  const kind = (toolCall.kind ?? '').toLowerCase()
  const title = toolCall.title?.trim() || ''
  const result = formatToolOutput(toolCall.rawOutput)
  const titleParts = parseTitleVerbParam(title)

  let toolHint = kind || 'tool'
  let commandLine = ''
  let param = titleParts?.param && titleParts.param.toLowerCase() !== 'file'
    ? titleParts.param
    : ''

  if (isReadLike(kind, title)) {
    toolHint = 'read'
    const path = input ? pickString(input, ['path', 'file_path', 'filePath', 'target', 'file']) : ''
    const range = input
      ? formatLineRange(
          input.start_line ?? input.startLine ?? input.line,
          input.end_line ?? input.endLine
        )
      : ''
    if (path) {
      param = `${basename(path)}${range}`
      commandLine = path + range
    }
  } else if (isListLike(kind, title)) {
    const path = input ? pickString(input, ['path', 'target', 'directory', 'dir', 'file_path']) : ''
    const command = input ? pickString(input, ['command', 'cmd']) : ''
    toolHint = 'ls'
    if (command) {
      commandLine = `$ ${command.trim()}`
      param = command.trim().startsWith('ls')
        ? listedTargetFromCommand(command, path)
        : command.trim()
      if (!command.trim().startsWith('ls')) toolHint = command.trim().split(/\s+/)[0] || 'shell'
    } else {
      commandLine = path ? `$ ls -la ${path}` : '$ ls -la'
      param = path ? basename(path) || path : '.'
    }
  } else if (isExecuteLike(kind, title)) {
    const command = input ? pickString(input, ['command', 'cmd', 'script', 'shell_command']) : ''
    if (command) {
      const trimmed = command.trim()
      toolHint = trimmed.split(/\s+/)[0] || 'shell'
      commandLine = `$ ${trimmed}`
      param = trimmed
    }
  } else if (input) {
    const command = pickString(input, ['command', 'cmd'])
    if (command) {
      const trimmed = command.trim()
      toolHint = trimmed.split(/\s+/)[0] || 'tool'
      commandLine = `$ ${trimmed}`
      param = trimmed
    } else {
      const path = pickString(input, ['path', 'file_path', 'filePath', 'target'])
      if (path) {
        param = basename(path) || path
        commandLine = path
        toolHint = kind || 'read'
      } else {
        commandLine = formatPayload(input)
      }
    }
  }

  let verb = pastTenseVerb(kind, title, toolHint)
  if (titleParts?.verb) verb = titleParts.verb
  if (!param && titleParts?.param && titleParts.param.toLowerCase() !== 'file') {
    param = titleParts.param
  }
  const inferred = param ? `${verb} ${param}` : (titleParts ? verb : verb)
  const foldLabel = !isGenericToolTitle(title) ? title : inferred

  return {
    foldLabel,
    commandLine,
    result
  }
}
