'use client'

import { useMemo, useState } from 'react'
import { Users, Check, AlertTriangle } from 'lucide-react'

import type {
  PickerCandidate,
  PickerRequest,
  PickerSelectionEntry
} from '@/types/os'

const PICKER_TITLES: Record<string, string> = {
  choose_director: 'Choose director',
  choose_representative_director: 'Choose representative director',
  choose_attendees: 'Choose attendees',
  choose_person_from_register: 'Choose person from register'
}

const NEW_ID = '__new__'

const candidateKey = (candidate: PickerCandidate, index: number) =>
  `${candidate.id || candidate.name || 'candidate'}-${index}`

const PickerCard = ({ request, onSubmit, disabled }: PickerCardProps) => {
  const { payload, status } = request
  const multi = payload.multi_select === true
  const readOnly = disabled === true || status !== 'pending'

  // Ordered selection — click order is preserved for multi-select.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // candidate id -> chosen representative id (corporate candidates only)
  const [repById, setRepById] = useState<Record<string, string>>({})
  const [newOpen, setNewOpen] = useState(false)
  const [newValues, setNewValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const candidatesById = useMemo(() => {
    const map = new Map<string, PickerCandidate>()
    payload.candidates.forEach((candidate, index) => {
      map.set(candidate.id || `idx:${index}`, candidate)
    })
    return map
  }, [payload.candidates])

  const newFields = payload.new_person_fields ?? []
  const newIsValid =
    newOpen &&
    newFields
      .filter((field) => field.required)
      .every((field) => (newValues[field.name] ?? '').trim().length > 0) &&
    (newValues['full_name'] ?? '').trim().length > 0

  const corporateNeedsRep = selectedIds.some((id) => {
    const candidate = candidatesById.get(id)
    return (
      candidate?.party_type === 'corporate' &&
      (candidate.representatives?.length ?? 0) > 0 &&
      !repById[id]
    )
  })

  const canConfirm =
    !readOnly &&
    !submitting &&
    ((selectedIds.length > 0 && !corporateNeedsRep) ||
      (newIsValid && selectedIds.length === 0)) &&
    (multi || selectedIds.length <= 1)

  const toggle = (id: string) => {
    if (readOnly) return
    setNewOpen(false)
    setSelectedIds((prev) => {
      if (!multi) return prev[0] === id ? [] : [id]
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    })
  }

  const buildSelection = (): PickerSelectionEntry | PickerSelectionEntry[] => {
    if (newIsValid && selectedIds.length === 0) {
      const entry: PickerSelectionEntry = {
        name: (newValues['full_name'] ?? '').trim(),
        is_new: true
      }
      newFields.forEach((field) => {
        const value = (newValues[field.name] ?? '').trim()
        if (value) entry[field.name] = value
      })
      return multi ? [entry] : entry
    }

    const entries: PickerSelectionEntry[] = selectedIds.map((id) => {
      const candidate = candidatesById.get(id)
      const rep = candidate?.representatives?.find(
        (r) => r.id === repById[id]
      )
      return {
        id: candidate?.id,
        name: candidate?.name ?? '',
        identifier: candidate?.identifier,
        party_type: candidate?.party_type,
        subtitle: candidate?.subtitle,
        representative: rep
          ? {
              id: rep.id,
              name: rep.name,
              identifier: rep.identifier,
              subtitle: rep.subtitle
            }
          : null
      }
    })
    return multi ? entries : entries[0]
  }

  const handleConfirm = async () => {
    if (!canConfirm || !onSubmit) return
    setSubmitting(true)
    try {
      await onSubmit(request, buildSelection())
    } finally {
      setSubmitting(false)
    }
  }

  const title = PICKER_TITLES[request.tool_name] ?? 'Choose'
  const companyName = payload.company?.name

  // ------------------------------------------------------------------ //

  if (request.parse_error) {
    return (
      <div
        className="mt-2 flex items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] p-3"
        role="alert"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger-strong)]" aria-hidden />
        <p className="text-[13px] text-[var(--text)]">
          <span className="font-semibold">Picker unavailable.</span>{' '}
          {request.parse_error} Please answer in chat instead.
        </p>
      </div>
    )
  }

  return (
    <section
      aria-label={`${title}${companyName ? ` for ${companyName}` : ''}`}
      className="mt-2 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] font-[family-name:var(--font-body)]"
    >
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Users className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
          <span className="truncate text-[13px] font-semibold text-[var(--text)]">
            {title}
          </span>
          <span className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
            {multi ? 'Select all that apply' : 'Select one'}
          </span>
        </div>
        {companyName && (
          <span className="truncate text-[12px] text-[var(--text-muted)]">
            {companyName}
          </span>
        )}
      </header>

      {/* Context */}
      {(payload.purpose || payload.note) && (
        <div className="border-b border-[var(--border)] px-3.5 py-2.5">
          {payload.purpose && (
            <p className="text-[13px] text-[var(--text)]">{payload.purpose}</p>
          )}
          {payload.note && (
            <p className="mt-1 text-[12px] text-[var(--text-muted)]">{payload.note}</p>
          )}
        </div>
      )}

      {/* Resolved banner */}
      {status !== 'pending' && (
        <div className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] px-3.5 py-2.5">
          <span className="text-[11px] font-medium uppercase tracking-[var(--tracking-tag)] text-[var(--ok-strong)]">
            {status === 'answered' ? 'Answered' : 'Closed'}
          </span>
          <p className="mt-1 text-[13px] text-[var(--text)]">
            {request.answer_summary
              ? request.answer_summary
              : status === 'historical'
                ? 'This request is from an earlier session and can no longer be answered here.'
                : 'Selection submitted.'}
          </p>
        </div>
      )}

      {/* Candidates */}
      <div
        role={multi ? 'group' : 'radiogroup'}
        aria-label={title}
        aria-disabled={readOnly}
        className="flex flex-col"
      >
        {payload.candidates.length === 0 && (
          <p className="px-3.5 py-3 text-[13px] text-[var(--text-muted)]">
            No candidates on record.
            {payload.allow_new ? ' Enter someone new below.' : ''}
          </p>
        )}

        {payload.candidates.map((candidate, index) => {
          const id = candidate.id || `idx:${index}`
          const checked = selectedIds.includes(id)
          const order = multi ? selectedIds.indexOf(id) + 1 : 0
          const isCorporate = candidate.party_type === 'corporate'
          const reps = candidate.representatives ?? []

          return (
            <div
              key={candidateKey(candidate, index)}
              className="border-b border-[var(--border)] last:border-b-0"
            >
              <div
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={checked}
                aria-disabled={readOnly}
                tabIndex={readOnly ? -1 : 0}
                onClick={() => toggle(id)}
                onKeyDown={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault()
                    toggle(id)
                  }
                }}
                className={`flex cursor-pointer items-start gap-3 px-3.5 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)] ${
                  checked
                    ? 'bg-[color-mix(in_srgb,var(--brand)_8%,transparent)]'
                    : 'hover:bg-[var(--bg-secondary)]'
                } ${readOnly ? 'cursor-default opacity-70' : ''}`}
              >
                {/* Marker: rounded box = checkbox, circle = radio, brand-filled
                    when chosen. */}
                <span
                  aria-hidden="true"
                  className={`mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center border ${
                    multi ? 'rounded-[4px]' : 'rounded-full'
                  } ${
                    checked
                      ? 'border-[var(--brand)] bg-[var(--brand)]'
                      : 'border-[var(--border-strong)] bg-[var(--surface)]'
                  }`}
                >
                  {checked &&
                    (multi ? (
                      <Check className="h-3 w-3 text-white" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-white" />
                    ))}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-[var(--text)]">
                      {candidate.name}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                        isCorporate
                          ? 'border-[color-mix(in_srgb,var(--danger)_35%,transparent)] text-[var(--danger-strong)]'
                          : 'border-[var(--border)] text-[var(--text-muted)]'
                      }`}
                    >
                      {isCorporate ? 'Corporate' : 'Individual'}
                    </span>
                    {multi && order > 0 && (
                      <span className="rounded-full bg-[var(--brand)] px-2 py-0.5 text-[10px] font-medium text-white">
                        #{order}
                      </span>
                    )}
                  </span>
                  {(candidate.identifier || candidate.subtitle) && (
                    <span className="mt-0.5 block text-[12px] text-[var(--text-muted)]">
                      {[candidate.identifier, candidate.subtitle]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </span>
              </div>

              {/* Second-level: a corporate party signs THROUGH a representative */}
              {isCorporate && checked && (
                <div className="ml-[26px] mb-2 mr-3 rounded-[var(--radius-md)] border-l-2 border-[var(--brand)] bg-[var(--bg-secondary)] px-3 py-2">
                  <span className="text-[11px] font-medium uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                    Signs through
                  </span>
                  {reps.length === 0 ? (
                    <p className="mt-1 text-[12px] font-medium text-[var(--danger-strong)]">
                      No representative directors on record for {candidate.name}.
                      Ask the agent to look them up.
                    </p>
                  ) : (
                    <div
                      role="radiogroup"
                      aria-label={`Representative for ${candidate.name}`}
                      className="mt-1 flex flex-col"
                    >
                      {reps.map((rep, repIndex) => {
                        const repChecked = repById[id] === rep.id
                        return (
                          <div
                            key={`${rep.id || rep.name}-${repIndex}`}
                            role="radio"
                            aria-checked={repChecked}
                            aria-disabled={readOnly}
                            tabIndex={readOnly ? -1 : 0}
                            onClick={() =>
                              !readOnly &&
                              setRepById((prev) => ({ ...prev, [id]: rep.id }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === ' ' || event.key === 'Enter') {
                                event.preventDefault()
                                if (!readOnly)
                                  setRepById((prev) => ({
                                    ...prev,
                                    [id]: rep.id
                                  }))
                              }
                            }}
                            className={`flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)] ${
                              repChecked
                                ? 'bg-[color-mix(in_srgb,var(--brand)_10%,transparent)]'
                                : ''
                            } ${readOnly ? 'cursor-default' : ''}`}
                          >
                            <span
                              aria-hidden="true"
                              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                                repChecked
                                  ? 'border-[var(--brand)] bg-[var(--brand)]'
                                  : 'border-[var(--border-strong)] bg-[var(--surface)]'
                              }`}
                            >
                              {repChecked && (
                                <span className="h-1.5 w-1.5 rounded-full bg-white" />
                              )}
                            </span>
                            <span className="text-[12px] font-medium text-[var(--text)]">
                              {rep.name}
                              {rep.identifier || rep.subtitle ? (
                                <span className="font-normal text-[var(--text-muted)]">
                                  {' '}
                                  ·{' '}
                                  {[rep.identifier, rep.subtitle]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Enter someone new — expanded fields */}
      {payload.allow_new &&
        newFields.length > 0 &&
        status === 'pending' &&
        newOpen && (
          <div className="border-t border-[var(--border)] px-3.5 py-2.5">
            <div className="flex flex-col gap-2">
              {newFields.map((field) => (
                <label key={field.name} className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                    {field.label}
                    {field.required ? ' *' : ''}
                  </span>
                  <input
                    type="text"
                    value={newValues[field.name] ?? ''}
                    disabled={readOnly}
                    required={field.required}
                    onChange={(event) =>
                      setNewValues((prev) => ({
                        ...prev,
                        [field.name]: event.target.value
                      }))
                    }
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--brand)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand)_25%,transparent)]"
                  />
                </label>
              ))}
            </div>
          </div>
        )}

      {/* Footer */}
      {status === 'pending' && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-3.5 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            {payload.allow_new && newFields.length > 0 && (
              <button
                type="button"
                disabled={readOnly}
                aria-expanded={newOpen}
                onClick={() => {
                  setNewOpen((open) => !open)
                  setSelectedIds([])
                }}
                className="w-fit text-[12px] font-medium text-[var(--brand)] outline-none transition-colors hover:text-[#1D4ED8] focus-visible:underline disabled:opacity-40"
              >
                {newOpen ? '− Cancel new entry' : '+ Enter someone new'}
              </button>
            )}
            <span
              className="text-[11px] text-[var(--text-muted)]"
              aria-live="polite"
            >
              {corporateNeedsRep
                ? 'Pick a representative director'
                : selectedIds.length > 0
                  ? `${selectedIds.length} selected`
                  : newOpen
                    ? 'New entry'
                    : 'Nothing selected'}
            </span>
          </div>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="rounded-[var(--radius-sm)] bg-[var(--brand)] px-3 py-1.5 text-[13px] font-medium text-white outline-none transition-colors hover:bg-[#1D4ED8] focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:bg-[var(--accent)] disabled:text-[var(--text-muted)]"
          >
            {submitting ? 'Sending…' : 'Confirm'}
          </button>
        </footer>
      )}
    </section>
  )
}

interface PickerCardProps {
  request: PickerRequest
  /** Only called while the card is live. */
  onSubmit?: (
    request: PickerRequest,
    selection: PickerSelectionEntry | PickerSelectionEntry[]
  ) => Promise<void> | void
  /** Force read-only regardless of status (e.g. another card is submitting). */
  disabled?: boolean
}

export default PickerCard
