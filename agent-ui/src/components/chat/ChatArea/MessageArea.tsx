'use client'

import { useStore } from '@/store'
import Messages from './Messages'
import ScrollToBottom from '@/components/chat/ChatArea/ScrollToBottom'
import { StickToBottom } from 'use-stick-to-bottom'

const MessageArea = () => {
  const { messages } = useStore()

  return (
    <StickToBottom
      className="relative mb-4 flex min-h-0 flex-grow flex-col overflow-y-auto"
      resize="smooth"
      initial="smooth"
    >
      {/* Top-aligned: a short thread starts at the top of the pane, never
          floats to the vertical middle. No session banner — the thread itself
          opens the page, Insights-style. */}
      <StickToBottom.Content className="flex min-h-full flex-col">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-4 pt-6">
          <Messages messages={messages} />
        </div>
      </StickToBottom.Content>
      <ScrollToBottom />
    </StickToBottom>
  )
}

export default MessageArea
