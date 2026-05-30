export interface NdJsonCodec<TIn = unknown, TOut = unknown> {
  encode: TransformStream<TIn, Uint8Array>
  decode: TransformStream<Uint8Array, TOut>
}

export function ndJsonStream<TIn = unknown, TOut = unknown>(): NdJsonCodec<TIn, TOut> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const encode = new TransformStream<TIn, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`))
    }
  })

  let buffer = ''
  const decode = new TransformStream<Uint8Array, TOut>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) {
          controller.enqueue(JSON.parse(line) as TOut)
        }
        idx = buffer.indexOf('\n')
      }
    },
    flush(controller) {
      const rest = buffer.trim()
      if (rest) controller.enqueue(JSON.parse(rest) as TOut)
    }
  })

  return { encode, decode }
}
