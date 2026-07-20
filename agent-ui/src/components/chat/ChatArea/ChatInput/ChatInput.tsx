'use client'
import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { TextArea } from '@/components/ui/textarea'
import { useStore } from '@/store'
import useAIChatStreamHandler from '@/hooks/useAIStreamHandler'
import { useQueryState } from 'nuqs'
import { Mail, ArrowUp, Square } from 'lucide-react'

const MAX_CHARS = 5000
const COUNTER_VISIBLE_FROM = 4500

const ChatInput = () => {
  const { chatInputRef, pendingMessage, setPendingMessage } = useStore()
  const { handleStreamResponse, cancelStream } = useAIChatStreamHandler()
  const [selectedAgent] = useQueryState('agent')
  const [teamId] = useQueryState('team')
  const [inputMessage, setInputMessage] = useState('')
  const isStreaming = useStore((state) => state.isStreaming)

  // No agent picked yet means the backend has nowhere to send the turn.
  const hasTarget = Boolean(selectedAgent || teamId)
  const canSend = hasTarget && !isStreaming && inputMessage.trim().length > 0

  const submitMessage = async (message: string) => {
    if (!message.trim()) return
    setInputMessage('')
    try {
      await handleStreamResponse(message)
    } catch (error) {
      toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      setInputMessage(message)
    }
  }

  useEffect(() => {
    if (pendingMessage) {
      submitMessage(pendingMessage)
      setPendingMessage(null)
    }
  }, [pendingMessage, setPendingMessage])

  const handleSubmit = async () => {
    if (!canSend) return
    await submitMessage(inputMessage)
  }

  const handleCancel = () => {
    cancelStream()
  }

  const remaining = MAX_CHARS - inputMessage.length
  const showCounter = inputMessage.length >= COUNTER_VISIBLE_FROM

  return (
    <div className="mx-auto w-full max-w-full px-4 pb-4 md:max-w-3xl lg:max-w-5xl">
      {/*
        The whole composer reads as one control: the container owns the frame and
        the focus ring (focus-within), the textarea inside is chrome-less. Actions
        sit on an inner toolbar so the writing area keeps its full width.

        rounded-[var(--radius-xl)] rather than rounded-xl: the radius comes from
        the --radius-xl token so the composer tracks the token layer rather than
        Tailwind's own rounding scale.

        The ring uses color-mix rather than a `/25` alpha modifier: Tailwind
        cannot apply an alpha modifier to a var() holding a hex, and emits no
        style at all — silently leaving the focus ring uncoloured.
      */}
      <div
        className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)]
                   shadow-sm transition-colors duration-150 motion-reduce:transition-none
                   focus-within:border-[var(--brand)]
                   focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--brand)_25%,transparent)]"
      >
        <TextArea
          placeholder={
            hasTarget
              ? 'Describe the document you need — e.g. "AGM minutes for City Holdings"'
              : 'Select an agent to start'
          }
          aria-label="Message Legal Scout"
          value={inputMessage}
          maxLength={MAX_CHARS}
          onChange={(e) => setInputMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey && !isStreaming) {
              e.preventDefault()
              handleSubmit()
            }
            if (e.key === 'Escape' && isStreaming) {
              e.preventDefault()
              handleCancel()
            }
          }}
          className="rounded-[var(--radius-xl)] border-0 bg-transparent px-4 pt-3 shadow-none
                     font-[family-name:var(--font-body)] text-[length:var(--text-sm)] text-[var(--text)]
                     placeholder:text-[var(--text-muted)]
                     focus-visible:border-0 focus-visible:ring-0"
          disabled={!hasTarget}
          ref={chatInputRef}
        />

        <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
          <button
            type="button"
            onClick={() => setPendingMessage('I want to send an email with a document attachment')}
            disabled={!hasTarget || isStreaming}
            title="Email a document"
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-xl)] px-2.5 py-1.5
                       font-[family-name:var(--font-body)] text-[length:var(--text-xs)] text-[var(--text-muted)]
                       transition-colors duration-150 motion-reduce:transition-none
                       hover:bg-[var(--accent)] hover:text-[var(--text)]
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]
                       disabled:pointer-events-none disabled:opacity-40"
          >
            <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            Email
          </button>

          <div className="ml-auto flex items-center gap-3">
            {showCounter && (
              <span
                className={`font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] tabular-nums ${
                  remaining <= 100 ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'
                }`}
              >
                {remaining}
              </span>
            )}

            <span className="hidden font-[family-name:var(--font-body)] text-[length:var(--text-2xs)] text-[var(--text-muted)] sm:inline">
              {isStreaming ? 'Esc to stop' : 'Enter to send · Shift+Enter for a new line'}
            </span>

            {isStreaming ? (
              <button
                type="button"
                onClick={handleCancel}
                aria-label="Stop generating"
                title="Stop generating"
                className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-xl)]
                           border border-[var(--border)] bg-[var(--surface)] text-[var(--danger)]
                           transition-colors duration-150 motion-reduce:transition-none
                           hover:bg-[var(--accent)]
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                <Square className="h-3 w-3 fill-current" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSend}
                aria-label="Send message"
                title="Send message"
                className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-xl)]
                           bg-[var(--brand)] text-[var(--brand-fg)]
                           transition-opacity duration-150 motion-reduce:transition-none
                           hover:opacity-90
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]
                           focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]
                           disabled:cursor-not-allowed disabled:bg-[var(--accent)] disabled:text-[var(--text-muted)]"
              >
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default ChatInput
