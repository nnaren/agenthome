import { buildToolCallDisplay } from './toolCallDisplay'
import type { ToolCallRecord } from '../../shared/chat'

/**
 * 流式 chunk：统一换行符。
 * 仅对纯 ASCII 英文 token 去掉末尾单个 \\n（避免逐词换行）；
 * 中文、标点、markdown（```）、目录树等保留换行。
 */
export function normalizeStreamChunk(chunk: string): string {
  if (!chunk) return ''
  const s = chunk.replace(/\r\n/g, '\n')
  if (/^\n+$/.test(s) || /\n\n$/.test(s)) return s
  if (!s.endsWith('\n')) return s

  const before = s.slice(0, -1)
  if (!before) return s
  if (!/^[\x09\x0a\x0d\x20-\x7e]+$/.test(s)) return s
  if (/[.!?:>#\])}`|/]$/.test(before)) return s
  if (/```/.test(before)) return s
  if (/[|├└─]/.test(before)) return s

  return before
}

/** 合并流式增量：支持全量 snapshot 与纯 delta */
export function mergeStreamDelta(current: string, chunk: string): string {
  const piece = normalizeStreamChunk(chunk)
  if (!piece) return current
  if (!current) return piece
  if (piece.startsWith(current)) return piece
  if (current.endsWith(piece)) return current
  if (current.startsWith(piece)) return current
  return current + piece
}

/** Claude / ACP 可能使用的思考块标签名 */
const THINK_BLOCK_RE = /<(?:redacted_)?think(?:ing)?>([\s\S]*?)<\/(?:redacted_)?think(?:ing)?>/gi
const THINK_OPEN_RE = /<(?:redacted_)?think(?:ing)?>/i
const THINK_TAG_RE = /<\/?(?:redacted_)?think(?:ing)?>/gi
const THINK_PARTIAL_TAIL_RE = /<(?:redacted_)?think(?:ing)?>[\s\S]*$/i

/** 提取流中每一段 thinking（闭合块 + 当前未闭合块） */
export function extractAllThoughtBlocks(text: string): string[] {
  const thoughts: string[] = []
  const closedRe = /<(?:redacted_)?think(?:ing)?>([\s\S]*?)<\/(?:redacted_)?think(?:ing)?>/gi
  let match = closedRe.exec(text)
  while (match) {
    const trimmed = match[1].trim()
    if (trimmed) thoughts.push(trimmed)
    match = closedRe.exec(text)
  }

  const unclosed = text.match(/<(?:redacted_)?think(?:ing)?>([\s\S]*)$/i)
  if (unclosed) {
    const trimmed = unclosed[1].trim()
    if (trimmed) {
      const last = thoughts[thoughts.length - 1]
      if (thoughts.length > 0 && trimmed.startsWith(last)) {
        thoughts[thoughts.length - 1] = trimmed
      } else if (last !== trimmed) {
        thoughts.push(trimmed)
      }
    }
  }
  return thoughts
}

/**
 * 从正文中拆出思考块与可见回复。
 */
export function extractThinkingFromTags(text: string): { thought: string; message: string } {
  const blocks = extractAllThoughtBlocks(text)
  let rest = text.replace(THINK_BLOCK_RE, '')
  rest = rest.replace(/<(?:redacted_)?think(?:ing)?>[\s\S]*$/i, '')
  const message = prepareMessageForDisplay(stripThinkMarkupFromMessage(rest))
  return {
    thought: blocks.join('\n\n').trim(),
    message
  }
}

export function countClosedThinkBlocks(text: string): number {
  return (text.match(/<\/(?:redacted_)?think(?:ing)?>/gi) ?? []).length
}

/** 展示正文：<br> 转 \n；连续换行合并；去掉末尾空行，避免占满最后一行 */
export function prepareMessageForDisplay(text: string): string {
  if (!text) return ''
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/\n+$/, '')
    .trimEnd()
}

/** @deprecated 仅用于旧终端缓冲清理 */
export function collapseSpuriousNewlines(text: string): string {
  return prepareMessageForDisplay(text)
}

export function normalizeMessageForDisplay(text: string): string {
  return prepareMessageForDisplay(text)
}

export function stripThinkMarkupFromMessage(text: string): string {
  return text
    .replace(THINK_PARTIAL_TAIL_RE, '')
    .replace(THINK_TAG_RE, '')
    .trim()
}

export function hasVisibleThinkTags(text: string): boolean {
  if (!text) return false
  return THINK_OPEN_RE.test(text) || THINK_TAG_RE.test(text) || THINK_PARTIAL_TAIL_RE.test(text)
}

/** 流中是否仍有未闭合的 thinking 标签（仅此时应隐藏正文尾部） */
export function hasUnclosedThinkTags(text: string): boolean {
  if (!text) return false
  return THINK_PARTIAL_TAIL_RE.test(text)
}

/** 系统日志中展示原始 chunk，空白/控制字符转义为可见形式 */
export function escapeChunkForLog(chunk: string): string {
  return chunk
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\v/g, '\\v')
}

export const ACP_TOOL_CALL_LOG_MARKER = '[acp] tool_call: '
export const ACP_TOOL_CALL_UPDATE_LOG_MARKER = '[acp] tool_call_update: '

function formatPayloadForLog(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return escapeChunkForLog(value)
  try {
    return escapeChunkForLog(JSON.stringify(value))
  } catch {
    return escapeChunkForLog(String(value))
  }
}

export function formatToolCallLogLine(toolCall: ToolCallRecord): string {
  const display = buildToolCallDisplay(toolCall)
  const meta: string[] = [`id=${toolCall.toolCallId}`]
  if (toolCall.kind) meta.push(`kind=${toolCall.kind}`)
  if (toolCall.status) meta.push(`status=${toolCall.status}`)
  let line = `${ACP_TOOL_CALL_LOG_MARKER}${display.foldLabel} (${meta.join(', ')})`
  const input = formatPayloadForLog(toolCall.rawInput)
  if (input) line += ` input=${input}`
  const output = formatPayloadForLog(toolCall.rawOutput)
  if (output) line += ` output=${output}`
  return line
}

export function formatToolCallUpdateLogLine(update: {
  toolCallId: string
  title?: string
  status?: string
  kind?: string
  rawInput?: unknown
  rawOutput?: unknown
}): string {
  const meta: string[] = [`id=${update.toolCallId}`]
  if (update.title) meta.push(`title=${update.title}`)
  if (update.kind) meta.push(`kind=${update.kind}`)
  if (update.status) meta.push(`status=${update.status}`)
  let line = `${ACP_TOOL_CALL_UPDATE_LOG_MARKER}${meta.join(', ')}`
  const input = formatPayloadForLog(update.rawInput)
  if (input) line += ` input=${input}`
  const output = formatPayloadForLog(update.rawOutput)
  if (output) line += ` output=${output}`
  return line
}
