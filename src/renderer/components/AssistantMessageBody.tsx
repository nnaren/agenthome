import { prepareMessageForDisplay } from '../utils/streamText'
import { splitMessageBlocks } from '../utils/messageMarkdown'

interface AssistantMessageBodyProps {
  content: string
}

function AssistantMessageBody({ content }: AssistantMessageBodyProps) {
  const text = prepareMessageForDisplay(content)
  if (!text) return null

  const blocks = splitMessageBlocks(text)

  return (
    <div className="chat-assistant-body">
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return (
            <pre
              key={`code-${i}`}
              className={`chat-code-block${block.incomplete ? ' chat-code-block-streaming' : ''}`}
            >
              <code>{block.content}</code>
            </pre>
          )
        }
        if (!block.content) return null
        return (
          <div key={`text-${i}`} className="chat-assistant-text">
            {block.content}
          </div>
        )
      })}
    </div>
  )
}

export default AssistantMessageBody
