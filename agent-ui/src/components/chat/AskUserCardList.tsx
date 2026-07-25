'use client'

import { useState } from 'react'

import AskUserCard from './AskUserCard'
import useAIChatStreamHandler from '@/hooks/useAIStreamHandler'
import type { AskUserAnswerMap, AskUserRequest } from '@/types/os'

/**
 * Renders every outstanding `ask_user` question card carried by one message.
 *
 * A single RunPaused event can carry more than one paused tool, so N cards are
 * rendered. Only one can be answered at a time: resuming the run consumes the
 * pause, so the remaining cards are locked while a submit is in flight and the
 * backend re-pauses for whatever is still outstanding.
 */
const AskUserCardList = ({ requests }: { requests?: AskUserRequest[] }) => {
  const { continueRunAskUser } = useAIChatStreamHandler()
  const [busy, setBusy] = useState(false)

  if (!requests?.length) return null

  const handleSubmit = async (
    request: AskUserRequest,
    answers: AskUserAnswerMap
  ) => {
    setBusy(true)
    try {
      await continueRunAskUser(request, answers)
    } finally {
      setBusy(false)
    }
  }

  const pending = requests.filter((request) => request.status === 'pending')
  const queued = pending.length > 1

  return (
    <section
      aria-label="Questions to answer"
      className="mt-2 font-[family-name:var(--font-body)]"
      data-ask-user-list=""
    >
      {/* Queue strip — only earns its space when more than one is outstanding */}
      {queued && (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-2">
          <span className="text-[12px] font-semibold text-[var(--text)]">
            {pending.length} questions to answer
          </span>
          <span className="text-[11px] text-[var(--text-muted)]">
            Answer one at a time
          </span>
        </div>
      )}

      <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto overflow-x-hidden">
        {requests.map((request) => (
          <div key={request.tool_call_id} className="min-w-0">
            <AskUserCard
              request={request}
              onSubmit={handleSubmit}
              disabled={busy && request.status === 'pending'}
            />
          </div>
        ))}
      </div>

      <p aria-live="polite" className="sr-only">
        {busy ? 'Submitting answers' : ''}
      </p>
    </section>
  )
}

export default AskUserCardList
