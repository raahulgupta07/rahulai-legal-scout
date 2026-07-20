'use client'

import ChatInput from './ChatInput'
import MessageArea from './MessageArea'
const ChatArea = () => {
  return (
    <main className="relative m-0 flex flex-grow flex-col bg-[var(--bg)]">
      <MessageArea />
      <div className="sticky bottom-0 bg-[var(--bg)] px-4 pb-0">
        <ChatInput />
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 py-2 text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-muted)]">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-[999px] bg-[var(--ok)]" />
            System active
          </span>
          <span>Legal Scout · Myanmar</span>
        </div>
      </div>
    </main>
  )
}

export default ChatArea
