'use client'

import { useState } from 'react'

import PickerCard from './PickerCard'
import useAIChatStreamHandler from '@/hooks/useAIStreamHandler'
import type { PickerRequest, PickerSelectionEntry } from '@/types/os'

/**
 * Renders every outstanding picker requirement carried by one message.
 *
 * A single RunPaused event can carry more than one paused tool, so N cards are
 * rendered. Only one can be answered: resuming the run consumes the pause, so
 * the remaining cards are locked while a submit is in flight and the backend
 * re-pauses for whatever is still outstanding.
 */

/**
 * The card owns the "enter someone new" form only when the backend supplied a
 * field schema. When it did not, the person is otherwise unreachable — the
 * client rejected any flow that forces a typed-out list — so the container
 * supplies a minimal name-only escape hatch of its own.
 */
const needsFallbackNewEntry = (request: PickerRequest) =>
  request.status === 'pending' &&
  !request.parse_error &&
  request.payload.allow_new &&
  !(request.payload.new_person_fields?.length ?? 0)

const PickerCardList = ({ requests }: { requests?: PickerRequest[] }) => {
  const { continueRun } = useAIChatStreamHandler()
  const [busy, setBusy] = useState(false)
  // tool_call_id -> typed name, for the container-level escape hatch
  const [fallbackNames, setFallbackNames] = useState<Record<string, string>>({})

  if (!requests?.length) return null

  const handleSubmit = async (
    request: PickerRequest,
    selection: PickerSelectionEntry | PickerSelectionEntry[]
  ) => {
    setBusy(true)
    try {
      await continueRun(request, selection)
    } finally {
      setBusy(false)
    }
  }

  const submitFallbackNew = async (request: PickerRequest) => {
    const name = (fallbackNames[request.tool_call_id] ?? '').trim()
    if (!name || busy) return
    const entry: PickerSelectionEntry = { name, is_new: true }
    await handleSubmit(request, request.payload.multi_select ? [entry] : entry)
    setFallbackNames((prev) => ({ ...prev, [request.tool_call_id]: '' }))
  }

  const pending = requests.filter((request) => request.status === 'pending')
  const queued = pending.length > 1

  return (
    <section
      aria-label="Selections required"
      className="mt-2 font-[family-name:var(--font-body)]"
      data-picker-list=""
    >
      {/* Queue strip — only earns its space when more than one is outstanding */}
      {queued && (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-2">
          <span className="text-[12px] font-semibold text-[var(--text)]">
            {pending.length} selections required
          </span>
          <span className="text-[11px] text-[var(--text-muted)]">
            Answer one at a time
          </span>
        </div>
      )}

      {/* A long candidate register scrolls inside itself, never sideways. */}
      <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto overflow-x-hidden">
        {requests.map((request) => (
          <div key={request.tool_call_id} className="min-w-0">
            <PickerCard
              request={request}
              onSubmit={handleSubmit}
              disabled={busy && request.status === 'pending'}
            />

            {needsFallbackNewEntry(request) && (
              <div className="mt-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-2.5">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <label
                      className="text-[12px] font-medium text-[var(--text-secondary)]"
                      htmlFor={`picker-new-${request.tool_call_id}`}
                    >
                      Not on the register? Enter someone new
                    </label>
                    <input
                      id={`picker-new-${request.tool_call_id}`}
                      type="text"
                      value={fallbackNames[request.tool_call_id] ?? ''}
                      disabled={busy}
                      placeholder="Full name"
                      onChange={(event) =>
                        setFallbackNames((prev) => ({
                          ...prev,
                          [request.tool_call_id]: event.target.value
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void submitFallbackNew(request)
                        }
                      }}
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand)_25%,transparent)] disabled:opacity-40"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={
                      busy || !(fallbackNames[request.tool_call_id] ?? '').trim()
                    }
                    onClick={() => void submitFallbackNew(request)}
                    className="rounded-[var(--radius-sm)] bg-[var(--brand)] px-3 py-1.5 text-[13px] font-medium text-white outline-none transition-colors hover:bg-[#1D4ED8] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)] disabled:cursor-not-allowed disabled:bg-[var(--accent)] disabled:text-[var(--text-muted)]"
                  >
                    Use this person
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <p
        aria-live="polite"
        className="sr-only"
      >
        {busy ? 'Submitting selection' : ''}
      </p>
    </section>
  )
}

export default PickerCardList
