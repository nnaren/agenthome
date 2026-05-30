export type MessageBlock =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; lang?: string; incomplete?: boolean }

/** 将助手正文拆成普通文本与 ``` 围栏代码块 */
export function splitMessageBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = []
  let remaining = text

  while (remaining.length > 0) {
    const fence = remaining.indexOf('```')
    if (fence === -1) {
      blocks.push({ type: 'text', content: remaining })
      break
    }

    if (fence > 0) {
      blocks.push({ type: 'text', content: remaining.slice(0, fence) })
    }

    remaining = remaining.slice(fence + 3)
    let lang = ''
    const langMatch = remaining.match(/^([a-zA-Z0-9_+. -]*)\r?\n/)
    if (langMatch) {
      lang = langMatch[1].trim()
      remaining = remaining.slice(langMatch[0].length)
    }

    const close = remaining.indexOf('```')
    if (close === -1) {
      blocks.push({
        type: 'code',
        lang: lang || undefined,
        content: remaining,
        incomplete: true
      })
      break
    }

    blocks.push({
      type: 'code',
      lang: lang || undefined,
      content: remaining.slice(0, close)
    })
    remaining = remaining.slice(close + 3)
  }

  return blocks
}
