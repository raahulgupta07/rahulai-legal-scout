'use client'

import { useStore } from '@/store'

/**
 * The approval a stalled turn owed the user.
 *
 * `preview_doc` renders the field table and then, per its own
 * `agent_instruction`, the model is supposed to call `ask_questions` with one
 * question and two fixed options. Measured over six conversations it reliably
 * did neither — the turn ended with zero characters of content, leaving a
 * preview the user could read and could not act on.
 *
 * This is NOT an `AskUserCard`. Those answer a PAUSED run by resuming it
 * through /continue, consuming the pause the backend is holding. Here the run
 * has COMPLETED, so there is no pause to consume; sending the chosen option as
 * an ordinary next message is the only correct move, and it is the same
 * mechanism the silent-stop nudge already uses — except the words are the
 * user's decision rather than a synthetic "continue".
 *
 * The consequence worth knowing: the user's choice appears in the transcript as
 * a message they sent, because that is exactly what it is.
 */
const ApprovalPrompt = ({
  approval
}: {
  approval?: { question: string; options: string[] } | null
}) => {
  const setPendingMessage = useStore((state) => state.setPendingMessage)

  if (!approval?.question || !approval.options?.length) return null

  return (
    <section
      aria-label="Approval needed"
      data-approval-prompt=""
      className="mt-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-3"
    >
      <p className="text-[13px] font-semibold leading-[1.5] text-[var(--text)]">
        {approval.question}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {approval.options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setPendingMessage(option)}
            className="cursor-pointer rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[13px] leading-[1.4] text-[var(--text)] transition-colors hover:border-[var(--brand)] hover:text-[var(--brand)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            {option}
          </button>
        ))}
      </div>
    </section>
  )
}

export default ApprovalPrompt
