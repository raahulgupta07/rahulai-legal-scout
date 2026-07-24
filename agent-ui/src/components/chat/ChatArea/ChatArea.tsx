'use client'

import ChatInput from './ChatInput'
import MessageArea from './MessageArea'
import { useStore } from '@/store'
import {
  HomeBackdrop,
  BlankStateHero,
  BlankStateChips
} from './Messages/ChatBlankState'

const StatusBar = () => (
  <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 py-2 text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-muted)]">
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-[999px] bg-[var(--ok)]" />
      System active
    </span>
    <span>Legal Scout · Myanmar</span>
  </div>
)

const ChatArea = () => {
  // Subscribe to the emptiness boolean only, so this re-renders on the
  // empty→thread flip and not on every streamed chunk.
  const isEmpty = useStore((s) => s.messages.length === 0)

  return (
    <main className="relative m-0 flex flex-grow flex-col bg-[var(--bg)]">
      {/* Thread lives above the composer once there is one; on the empty home
          it is absent and the composer block below expands to centre itself. */}
      {!isEmpty && <MessageArea />}

      {/*
        ONE composer block serves both states. <ChatInput/> is kept at a fixed
        position in the tree (child index 2 of this block, inside the wrapper
        div at index 2) across both branches, so React never remounts it — the
        composer's local draft and the store-backed streaming/abort wiring
        survive the empty→thread flip untouched. Only classNames and the
        conditional decoration/hero/chips siblings change between states.

        Empty  : centred column — backdrop, hero, composer, chips.
        Thread : composer pinned to the bottom with the status strip beneath.
      */}
      <div
        className={
          isEmpty
            ? 'relative isolate flex flex-1 flex-col items-center justify-center px-4'
            : 'sticky bottom-0 flex flex-col bg-[var(--bg)] px-4 pb-0'
        }
      >
        {isEmpty && <HomeBackdrop />}
        {isEmpty && (
          <div className="relative z-10 mb-6 w-full max-w-2xl">
            <BlankStateHero />
          </div>
        )}

        {/* The composer — stable tree position in both states. In the thread
            state it shares the messages' column width so the whole surface
            reads as one column. */}
        <div
          className={
            isEmpty
              ? 'relative z-10 w-full max-w-2xl'
              : 'mx-auto w-full max-w-3xl'
          }
        >
          <ChatInput />
        </div>

        {isEmpty ? (
          <div className="relative z-10 mt-2 w-full max-w-2xl">
            <BlankStateChips />
          </div>
        ) : (
          <StatusBar />
        )}
      </div>
    </main>
  )
}

export default ChatArea
