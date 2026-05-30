import {
  mergeStreamDelta,
  prepareMessageForDisplay,
  stripThinkMarkupFromMessage
} from './streamText'

export interface ThoughtBlockState {
  content: string
  startedAt: number
  endedAt?: number
  expanded: boolean
}

export type MessageSegment =
  | { type: 'thought'; thoughtIndex: number }
  | { type: 'tool'; toolCallId: string }

const CLOSED_THINK_RE = /<(?:redacted_)?think(?:ing)?>([\s\S]*?)<\/(?:redacted_)?think(?:ing)?>/gi
const OPEN_THINK_TAIL_RE = /<(?:redacted_)?think(?:ing)?>([\s\S]*)$/i

export function extractMessageBodyWithoutThink(streamRaw: string): string {
  let rest = streamRaw.replace(CLOSED_THINK_RE, '')
  rest = rest.replace(OPEN_THINK_TAIL_RE, '')
  return prepareMessageForDisplay(stripThinkMarkupFromMessage(rest))
}

export interface ApplyStreamChunkInput {
  streamRaw: string
  thoughts: ThoughtBlockState[]
  segments: MessageSegment[]
  materializedThinkCount: number
  content: string
}

export interface ApplyStreamChunkResult {
  streamRaw: string
  thoughts: ThoughtBlockState[]
  segments: MessageSegment[]
  materializedThinkCount: number
  content: string
}

/** 按到达顺序增量解析 think；闭合标签即结束该块，正文与 think 分离 */
export function applyMessageStreamChunk(
  input: ApplyStreamChunkInput,
  piece: string
): ApplyStreamChunkResult {
  const streamRaw = input.streamRaw + piece
  let thoughts = [...input.thoughts]
  let segments = [...input.segments]
  let materialized = input.materializedThinkCount

  const closedRe = new RegExp(CLOSED_THINK_RE.source, 'gi')
  const matches = [...streamRaw.matchAll(closedRe)]

  for (let i = materialized; i < matches.length; i++) {
    const inner = matches[i][1]?.trim() ?? ''
    if (!inner) continue
    const openStreaming = thoughts[thoughts.length - 1]
    if (openStreaming && !openStreaming.endedAt) {
      thoughts = thoughts.slice(0, -1)
      const lastSeg = segments[segments.length - 1]
      if (lastSeg?.type === 'thought' && lastSeg.thoughtIndex === thoughts.length) {
        segments = segments.slice(0, -1)
      }
    }
    const thoughtIndex = thoughts.length
    thoughts.push({
      content: prepareMessageForDisplay(inner),
      startedAt: Date.now(),
      endedAt: Date.now(),
      expanded: false
    })
    segments.push({ type: 'thought', thoughtIndex })
  }
  materialized = matches.length

  let tail = streamRaw.replace(new RegExp(CLOSED_THINK_RE.source, 'gi'), '')
  const unclosed = tail.match(OPEN_THINK_TAIL_RE)
  if (unclosed) {
    const partial = prepareMessageForDisplay(unclosed[1] ?? '')
    const last = thoughts[thoughts.length - 1]
    const lastSeg = segments[segments.length - 1]
    if (
      last
      && !last.endedAt
      && lastSeg?.type === 'thought'
      && lastSeg.thoughtIndex === thoughts.length - 1
    ) {
      thoughts[thoughts.length - 1] = { ...last, content: partial }
    } else {
      const thoughtIndex = thoughts.length
      thoughts.push({
        content: partial,
        startedAt: Date.now(),
        expanded: false
      })
      segments.push({ type: 'thought', thoughtIndex })
    }
  } else if (thoughts.length > 0 && !thoughts[thoughts.length - 1].endedAt) {
    const last = thoughts[thoughts.length - 1]
    thoughts[thoughts.length - 1] = {
      ...last,
      endedAt: Date.now(),
      expanded: false
    }
  }

  const body = extractMessageBodyWithoutThink(streamRaw)
  const content =
    body.length >= input.content.length ? body : input.content

  return {
    streamRaw,
    thoughts,
    segments,
    materializedThinkCount: materialized,
    content
  }
}

export function finalizeAllThoughts(
  thoughts: ThoughtBlockState[]
): ThoughtBlockState[] {
  return thoughts.map((t) =>
    (t.endedAt ? t : { ...t, endedAt: Date.now(), expanded: false })
  )
}

export function appendToolSegment(
  segments: MessageSegment[],
  toolCallId: string
): MessageSegment[] {
  if (segments.some((s) => s.type === 'tool' && s.toolCallId === toolCallId)) {
    return segments
  }
  return [...segments, { type: 'tool', toolCallId }]
}

/** 无 segments 记录时按 think/tools 数量回退（兼容旧数据） */
export function rebuildSegments(
  thoughts: ThoughtBlockState[],
  toolCallIds: string[]
): MessageSegment[] {
  const segments: MessageSegment[] = []
  if (toolCallIds.length > 0 && thoughts.length > 0) {
    for (let i = 0; i < toolCallIds.length; i++) {
      if (thoughts[i]) segments.push({ type: 'thought', thoughtIndex: i })
      segments.push({ type: 'tool', toolCallId: toolCallIds[i] })
    }
    for (let i = toolCallIds.length; i < thoughts.length; i++) {
      segments.push({ type: 'thought', thoughtIndex: i })
    }
    return segments
  }
  thoughts.forEach((_, i) => segments.push({ type: 'thought', thoughtIndex: i }))
  toolCallIds.forEach((id) => segments.push({ type: 'tool', toolCallId: id }))
  return segments
}

/** ACP agent_thought_chunk：无 think 标签，直接追加到当前未闭合思考块 */
export function applyThoughtStreamChunk(
  input: ApplyStreamChunkInput,
  piece: string
): ApplyStreamChunkResult {
  if (!piece) return input

  let thoughts = [...input.thoughts]
  let segments = [...input.segments]
  const last = thoughts[thoughts.length - 1]
  const lastSeg = segments[segments.length - 1]

  if (
    last
    && !last.endedAt
    && lastSeg?.type === 'thought'
    && lastSeg.thoughtIndex === thoughts.length - 1
  ) {
    thoughts[thoughts.length - 1] = {
      ...last,
      content: prepareMessageForDisplay(mergeStreamDelta(last.content, piece))
    }
  } else {
    const thoughtIndex = thoughts.length
    thoughts.push({
      content: prepareMessageForDisplay(piece),
      startedAt: Date.now(),
      expanded: false
    })
    segments.push({ type: 'thought', thoughtIndex })
  }

  return { ...input, thoughts, segments }
}
