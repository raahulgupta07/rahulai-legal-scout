'use client'

import { useStore } from '@/store'
import Messages from './Messages'
import ScrollToBottom from '@/components/chat/ChatArea/ScrollToBottom'
import { StickToBottom } from 'use-stick-to-bottom'
import { useState, useEffect } from 'react'

const SessionTag = () => {
  const [time, setTime] = useState('')
  useEffect(() => {
    const update = () => setTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase())
    update()
    const interval = setInterval(update, 60000)
    return () => clearInterval(interval)
  }, [])
  // A quiet dated rule rather than a centred badge — it separates the thread
  // from the header without competing with the first message for attention.
  return (
    <div className="flex items-center gap-3 pb-2 pt-4">
      <span className="text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-muted)]">
        Legal Scout · {time}
      </span>
      <span aria-hidden className="h-px flex-1 bg-[var(--border)]" />
    </div>
  )
}

const MessageArea = () => {
  const { messages } = useStore()

  return (
    <StickToBottom
      className="relative mb-4 flex max-h-[calc(100vh-64px)] min-h-0 flex-grow flex-col"
      resize="smooth"
      initial="smooth"
    >
      <StickToBottom.Content className="flex min-h-full flex-col justify-center">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-4">
          {messages.length > 0 && <SessionTag />}
          <Messages messages={messages} />
        </div>
      </StickToBottom.Content>
      <ScrollToBottom />
    </StickToBottom>
  )
}

export default MessageArea
