'use client'

import { useState } from 'react'
import { HelpCircle, Check } from 'lucide-react'

import type {
  AskUserAnswer,
  AskUserAnswerMap,
  AskUserQuestion,
  AskUserRequest
} from '@/types/os'

/** Sentinel for the "Other…" choice; the real answer is the typed text. */
const OTHER = '__other__'

interface AskUserCardProps {
  request: AskUserRequest
  /** Only called while the card is live. */
  onSubmit?: (
    request: AskUserRequest,
    answers: AskUserAnswerMap
  ) => Promise<void> | void
  /** Force read-only regardless of status (e.g. another card is submitting). */
  disabled?: boolean
}

const AskUserCard = ({ request, onSubmit, disabled }: AskUserCardProps) => {
  const { questions, status } = request
  const readOnly = disabled === true || status !== 'pending'

  // Single-select: question id -> chosen option (or OTHER).
  const [singlePick, setSinglePick] = useState<Record<string, string>>({})
  // Multi-select: question id -> chosen options (may include OTHER).
  const [multiPick, setMultiPick] = useState<Record<string, string[]>>({})
  // Free-text questions: question id -> text.
  const [freeText, setFreeText] = useState<Record<string, string>>({})
  // "Other…" text, keyed by question id (single or multi).
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  // A single choose-one question with fixed options and no free-form escape
  // hatch resolves in one click — no Confirm needed.
  const single = questions.length === 1 ? questions[0] : null
  const autoSubmit =
    !!single &&
    !!single.options?.length &&
    !single.multi_select &&
    !single.allow_other

  const answerFor = (question: AskUserQuestion): AskUserAnswer | null => {
    if (!question.options?.length) {
      const text = (freeText[question.id] ?? '').trim()
      return text ? text : null
    }
    if (question.multi_select) {
      const picks = multiPick[question.id] ?? []
      const values: string[] = []
      picks.forEach((pick) => {
        if (pick === OTHER) {
          const text = (otherText[question.id] ?? '').trim()
          if (text) values.push(text)
        } else {
          values.push(pick)
        }
      })
      return values.length ? values : null
    }
    const pick = singlePick[question.id]
    if (!pick) return null
    if (pick === OTHER) {
      const text = (otherText[question.id] ?? '').trim()
      return text ? text : null
    }
    return pick
  }

  const buildAnswers = (): AskUserAnswerMap => {
    const map: AskUserAnswerMap = {}
    questions.forEach((question) => {
      const answer = answerFor(question)
      if (answer !== null) map[question.id] = answer
    })
    return map
  }

  const allAnswered = questions.every(
    (question) => answerFor(question) !== null
  )
  const canSubmit = !readOnly && !submitting && allAnswered

  const submit = async (answers: AskUserAnswerMap) => {
    if (!onSubmit || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(request, answers)
    } finally {
      setSubmitting(false)
    }
  }

  const chooseSingle = (question: AskUserQuestion, option: string) => {
    if (readOnly) return
    setSinglePick((prev) => ({ ...prev, [question.id]: option }))
    // Bow behaviour: the one-question fixed-choice card submits on click.
    if (autoSubmit && option !== OTHER) {
      void submit({ [question.id]: option })
    }
  }

  const toggleMulti = (question: AskUserQuestion, option: string) => {
    if (readOnly) return
    setMultiPick((prev) => {
      const current = prev[question.id] ?? []
      const next = current.includes(option)
        ? current.filter((value) => value !== option)
        : [...current, option]
      return { ...prev, [question.id]: next }
    })
  }

  const title = questions.length > 1 ? 'A few questions' : 'Quick question'
  const submitLabel = questions.length > 1 ? 'Submit answers' : 'Submit'

  // ------------------------------------------------------------------ //

  const chipClass = (selected: boolean) =>
    `rounded-full border px-3 py-1 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)] ${
      selected
        ? 'border-[var(--brand)] text-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_8%,transparent)]'
        : 'border-[var(--border-strong)] text-[var(--text)] hover:bg-[var(--bg-secondary)]'
    } ${readOnly ? 'cursor-default opacity-70' : 'cursor-pointer'}`

  const renderChoices = (question: AskUserQuestion) => {
    const multi = question.multi_select === true
    const chosen = multi
      ? (multiPick[question.id] ?? [])
      : singlePick[question.id]
        ? [singlePick[question.id]]
        : []
    const otherActive = chosen.includes(OTHER)

    return (
      <div className="flex flex-col gap-2">
        <div
          role={multi ? 'group' : 'radiogroup'}
          aria-label={question.text}
          className="flex flex-wrap gap-1.5"
        >
          {(question.options ?? []).map((option, index) => {
            const selected = chosen.includes(option)
            return (
              <button
                key={`${question.id}-${index}`}
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={selected}
                disabled={readOnly}
                onClick={() =>
                  multi
                    ? toggleMulti(question, option)
                    : chooseSingle(question, option)
                }
                className={chipClass(selected)}
              >
                {multi && selected && (
                  <Check className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden />
                )}
                {option}
              </button>
            )
          })}

          {question.allow_other && (
            <button
              type="button"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={otherActive}
              disabled={readOnly}
              onClick={() =>
                multi
                  ? toggleMulti(question, OTHER)
                  : chooseSingle(question, OTHER)
              }
              className={chipClass(otherActive)}
            >
              Other…
            </button>
          )}
        </div>

        {question.allow_other && otherActive && (
          <input
            type="text"
            value={otherText[question.id] ?? ''}
            disabled={readOnly}
            placeholder="Type your answer"
            autoFocus={!readOnly}
            onChange={(event) =>
              setOtherText((prev) => ({
                ...prev,
                [question.id]: event.target.value
              }))
            }
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand)_25%,transparent)] disabled:opacity-40"
          />
        )}
      </div>
    )
  }

  const renderFreeText = (question: AskUserQuestion) => {
    const soleQuestion = questions.length === 1
    return (
      <input
        type="text"
        value={freeText[question.id] ?? ''}
        disabled={readOnly}
        placeholder="Type your answer"
        onChange={(event) =>
          setFreeText((prev) => ({
            ...prev,
            [question.id]: event.target.value
          }))
        }
        onKeyDown={(event) => {
          // A lone free-text question submits on Enter, like a mini-composer.
          if (event.key === 'Enter' && soleQuestion && canSubmit) {
            event.preventDefault()
            void submit(buildAnswers())
          }
        }}
        className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand)_25%,transparent)] disabled:opacity-40"
      />
    )
  }

  return (
    <section
      aria-label={title}
      className="mt-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] font-[family-name:var(--font-body)]"
    >
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <HelpCircle
            className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
            aria-hidden
          />
          <span className="truncate text-[13px] font-semibold text-[var(--text)]">
            {title}
          </span>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
          {status === 'pending' ? 'Answer to continue' : 'Answered'}
        </span>
      </header>

      {/* Resolved banner */}
      {status !== 'pending' && (
        <div className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] px-3.5 py-2.5">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-[var(--tracking-tag)] text-[var(--ok-strong)]">
            <Check className="h-3 w-3" aria-hidden />
            {status === 'answered' ? 'Answered' : 'Closed'}
          </span>
          <p className="mt-1 text-[13px] text-[var(--text)]">
            {request.answer_summary
              ? request.answer_summary
              : status === 'historical'
                ? 'This request is from an earlier session and can no longer be answered here.'
                : 'Answers submitted.'}
          </p>
        </div>
      )}

      {/* Questions */}
      <div className="flex flex-col">
        {questions.map((question, index) => (
          <div
            key={question.id}
            className="border-b border-[var(--border)] px-3.5 py-3 last:border-b-0"
          >
            {question.options?.length ? (
              <>
                <p className="mb-2 text-[13px] font-medium text-[var(--text)]">
                  {question.text}
                </p>
                {renderChoices(question)}
              </>
            ) : (
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                  {question.text}
                </span>
                {renderFreeText(question)}
              </label>
            )}
            {questions.length > 1 && (
              <span className="sr-only">
                Question {index + 1} of {questions.length}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Footer — hidden for the one-click auto-submit card */}
      {status === 'pending' && !autoSubmit && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-3.5 py-2.5">
          <span
            className="text-[11px] text-[var(--text-muted)]"
            aria-live="polite"
          >
            {allAnswered
              ? 'Ready to submit'
              : questions.length > 1
                ? 'Answer every question'
                : 'Enter an answer'}
          </span>
          <button
            type="button"
            onClick={() => void submit(buildAnswers())}
            disabled={!canSubmit}
            className="rounded-[var(--radius-sm)] bg-[var(--brand)] px-3 py-1.5 text-[13px] font-medium text-white outline-none transition-colors hover:bg-[#1D4ED8] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:bg-[var(--accent)] disabled:text-[var(--text-muted)]"
          >
            {submitting ? 'Sending…' : submitLabel}
          </button>
        </footer>
      )}
    </section>
  )
}

export default AskUserCard
