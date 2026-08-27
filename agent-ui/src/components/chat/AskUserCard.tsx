'use client'

import { useMemo, useState } from 'react'
import { HelpCircle, Check } from 'lucide-react'

import { resolveAskUserAnswers } from './askUserPayload'
import { formatLegalDate, looksLikeDateQuestion, todayISO } from './legalDate'
import type {
  AskUserAnswer,
  AskUserAnswerMap,
  AskUserQuestion,
  AskUserRequest
} from '@/types/os'

/** Sentinel for the "Other…" choice; the real answer is the typed text. */
const OTHER = '__other__'

/**
 * Facts about a person that this system cannot know, and must not suggest.
 *
 * The People register holds a name, an NRC/passport, a nationality and a date
 * of birth — nothing else. Country of residence, home address, personal phone
 * and personal email are not in a DICA extract and are empty for every person
 * on file, which is why they are asked at all.
 *
 * The model, composing the question, offered "Myanmar" as a one-click chip for
 * COUNTRY OF RESIDENCE — inferred from the nationality it could see. The legal
 * skill says the opposite in as many words: "If it is missing for a signatory,
 * ask; do not infer it from nationality." A Myanmar national resident in
 * Singapore has a different answer, and only one of the two is right on a filed
 * consent form.
 *
 * A chip the user clicks without reading has the same effect as inferring the
 * value outright, so the chips are dropped here and the question falls back to
 * a plain box. The card is the only place these answers are given, which makes
 * it the only place the suggestion can actually be prevented.
 */
const UNKNOWABLE_FACT_RE =
  /countr(?:y|ies)\s+of\s+residence|residential\s+address|home\s+address|\bresides?\s+in\b|personal\s+(?:phone|email)|contact\s+(?:phone|number|email)|phone\s+number|email\s+address/i

const isUnknowableFact = (question: AskUserQuestion): boolean =>
  UNKNOWABLE_FACT_RE.test(question.text || '') ||
  UNKNOWABLE_FACT_RE.test((question.id || '').replace(/_/g, ' '))

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
  const { questions: authoredQuestions, status } = request
  const readOnly = disabled === true || status !== 'pending'

  // Drop suggested answers for facts the system cannot know. The question
  // survives; only the chips go, so the user types what is true instead of
  // clicking what was guessed.
  const questions = useMemo(
    () =>
      authoredQuestions.map((q) =>
        q.options?.length && isUnknowableFact(q)
          ? { ...q, options: undefined, allow_other: undefined }
          : q
      ),
    [authoredQuestions]
  )

  // Single-select: question id -> chosen option (or OTHER).
  const [singlePick, setSinglePick] = useState<Record<string, string>>({})
  // Multi-select: question id -> chosen options (may include OTHER).
  const [multiPick, setMultiPick] = useState<Record<string, string[]>>({})
  // Free-text questions: question id -> text. Seeded once from any
  // model-declared default, so a card that opens pre-filled stays pre-filled
  // across re-renders without an effect writing over the user's typing.
  const [freeText, setFreeText] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {}
    questions.forEach((question) => {
      if (question.options?.length) return
      // Every date box opens on today, not just the ones the model marked
      // `default: "today"`. Asked for directly: the calendar should start at
      // the current date and stay editable.
      //
      // This RELAXES a deliberate rule — the tool's own guidance reads "Never
      // on an effective or resignation date: a pre-filled box that the user
      // accepts without looking would put today's date into a signed legal
      // instrument." The seeded value is visible in the box and the user still
      // has to submit, so it is a shown default rather than a silent one, but
      // the exposure is real and is recorded here on purpose.
      if (
        question.default_value === 'today' ||
        question.input_type === 'date' ||
        looksLikeDateQuestion(question.text, question.id)
      ) {
        seed[question.id] = todayISO()
      }
    })
    return seed
  })
  // Date questions the user chose to type by hand instead. The picker is a
  // guess whenever the model did not declare `input_type`, so there is always
  // a way back to a plain box — a wrong guess must never trap an answer.
  const [manualEntry, setManualEntry] = useState<Record<string, boolean>>({})
  // "Other…" text, keyed by question id (single or multi).
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  // What this card sent. The live resolve path only flips `status` and writes
  // `answer_summary` — it never back-fills `user_input_schema` — so the card
  // itself is the only place that still knows the per-question answers it just
  // submitted. Keeping them lets a just-answered card show settled values
  // instead of falling back to the joined summary line.
  const [submittedAnswers, setSubmittedAnswers] =
    useState<AskUserAnswerMap | null>(null)

  // A single choose-one question with fixed options and no free-form escape
  // hatch resolves in one click — no Confirm needed.
  const single = questions.length === 1 ? questions[0] : null
  const autoSubmit =
    !!single &&
    !!single.options?.length &&
    !single.multi_select &&
    !single.allow_other

  /** True when this free-text question should collect a calendar date. */
  const isDateQuestion = (question: AskUserQuestion): boolean => {
    if (question.options?.length) return false
    if (manualEntry[question.id]) return false
    if (question.input_type === 'date') return true
    return looksLikeDateQuestion(question.text, question.id)
  }

  const answerFor = (question: AskUserQuestion): AskUserAnswer | null => {
    if (!question.options?.length) {
      const text = (freeText[question.id] ?? '').trim()
      if (!text) return null
      // The picker holds ISO; the document wants "30 June 2026".
      return isDateQuestion(question) ? formatLegalDate(text) : text
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
    setSubmittedAnswers(answers)
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

  // A resolved card must read as settled history, never as a live form: an
  // empty input under a green "Answered" banner looks like a second ask.
  const resolved = status !== 'pending'
  const lockedAnswers = useMemo<AskUserAnswerMap | null>(
    // History path: on resume agno stores the answers in `user_input_schema`
    // (the tool `result` stays null), so a rehydrated card recovers them there.
    () => submittedAnswers ?? resolveAskUserAnswers(request.user_input_schema),
    [submittedAnswers, request.user_input_schema]
  )

  // ------------------------------------------------------------------ //

  const chipClass = (selected: boolean) =>
    `rounded-full border px-3 py-1 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)] ${
      selected
        ? 'border-[var(--brand)] text-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_8%,transparent)]'
        : 'border-[var(--border-strong)] text-[var(--text)] hover:bg-[var(--bg-secondary)]'
    } ${readOnly ? 'cursor-default opacity-70' : 'cursor-pointer'}`

  const fieldClass =
    'w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand)_25%,transparent)] disabled:opacity-40'

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

  const renderDate = (question: AskUserQuestion) => {
    const value = freeText[question.id] ?? ''
    const set = (next: string) =>
      setFreeText((prev) => ({ ...prev, [question.id]: next }))

    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={value}
            disabled={readOnly}
            onChange={(event) => set(event.target.value)}
            className={`${fieldClass} max-w-[190px]`}
          />
          <button
            type="button"
            disabled={readOnly}
            onClick={() => set(todayISO())}
            className={chipClass(value === todayISO())}
          >
            Today
          </button>
          {value && (
            <button
              type="button"
              disabled={readOnly}
              onClick={() => set('')}
              className={chipClass(false)}
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-muted)]">
          {/* What actually reaches the document — shown because the picker
              displays the browser's locale format, not the document's. */}
          {value && (
            <span className="text-[var(--text)]">
              Goes in the document as{' '}
              <strong className="font-semibold">{formatLegalDate(value)}</strong>
            </span>
          )}
          <button
            type="button"
            disabled={readOnly}
            onClick={() =>
              setManualEntry((prev) => ({ ...prev, [question.id]: true }))
            }
            className="underline underline-offset-2 hover:text-[var(--text)] disabled:opacity-40"
          >
            Type instead
          </button>
        </div>
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

  /** Locked view of one question: the ask, plus the answer as plain text. */
  const renderSettled = (question: AskUserQuestion) => {
    const answer = lockedAnswers?.[question.id]
    const values =
      answer == null ? [] : Array.isArray(answer) ? answer.filter(Boolean) : [answer]

    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
          {question.text}
        </span>
        {values.length ? (
          <div className="flex flex-wrap gap-1.5">
            {values.map((value, index) => (
              <span
                key={`${question.id}-answer-${index}`}
                className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--ok-strong)_35%,transparent)] bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] px-2.5 py-1 text-[12px] font-medium text-[var(--text)]"
              >
                <Check
                  className="h-3 w-3 text-[var(--ok-strong)]"
                  aria-hidden
                />
                {value}
              </span>
            ))}
          </div>
        ) : (
          // Pre-rename history (and closed-without-answer cards) carry no
          // per-question map; the banner summary above is all there is.
          <span className="text-[13px] text-[var(--text-muted)]">
            {status === 'historical' ? 'Not answered' : 'Answer recorded'}
          </span>
        )}
      </div>
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
            {resolved ? (
              renderSettled(question)
            ) : question.options?.length ? (
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
                {isDateQuestion(question)
                  ? renderDate(question)
                  : renderFreeText(question)}
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
