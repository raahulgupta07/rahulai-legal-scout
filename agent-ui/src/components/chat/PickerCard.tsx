'use client'

import { useMemo, useState } from 'react'

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
        className="mt-2 border-[2px] border-r-[3px] border-b-[3px] border-[var(--danger-strong)] bg-[var(--bg)] p-3 font-brutalist"
        role="alert"
      >
        <span className="tag-label" style={{ background: 'var(--danger-strong)' }}>
          Picker unavailable
        </span>
        <p className="mt-2 text-[12px] font-bold text-[var(--ink)]">
          {request.parse_error} Please answer in chat instead.
        </p>
      </div>
    )
  }

  return (
    <section
      aria-label={`${title}${companyName ? ` for ${companyName}` : ''}`}
      className="mt-2 border-[2px] border-l-[2px] border-r-[3px] border-b-[3px] border-[var(--ink)] bg-[var(--bg)] font-brutalist"
      style={{ boxShadow: '4px 4px 0px 0px var(--ink)', borderRadius: 0 }}
    >
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[2px] border-[var(--ink)] bg-[var(--ink)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--ok-neon)]">
            {multi ? 'Select all that apply' : 'Select one'}
          </span>
          <span className="text-[11px] font-black uppercase tracking-[0.1em] text-[var(--bg)]">
            {title}
          </span>
        </div>
        {companyName && (
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[color-mix(in_srgb,var(--bg)_60%,transparent)]">
            {companyName}
          </span>
        )}
      </header>

      {/* Context */}
      {(payload.purpose || payload.note) && (
        <div className="border-b-[2px] border-[color-mix(in_srgb,var(--ink)_20%,transparent)] px-3 py-2">
          {payload.purpose && (
            <p className="text-[12px] font-bold text-[var(--ink)]">
              {payload.purpose}
            </p>
          )}
          {payload.note && (
            <p className="mt-1 text-[11px] text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">{payload.note}</p>
          )}
        </div>
      )}

      {/* Resolved banner */}
      {status !== 'pending' && (
        <div className="border-b-[2px] border-[color-mix(in_srgb,var(--ink)_20%,transparent)] bg-[color-mix(in_srgb,var(--ok-neon)_15%,transparent)] px-3 py-2">
          <span className="tag-label">
            {status === 'answered' ? 'Answered' : 'Closed'}
          </span>
          <p className="mt-1 text-[12px] font-bold text-[var(--ink)]">
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
          <p className="px-3 py-3 text-[12px] font-bold text-[color-mix(in_srgb,var(--ink)_60%,transparent)]">
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
              className="border-b-[1px] border-[color-mix(in_srgb,var(--ink)_15%,transparent)] last:border-b-0"
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
                className={`flex cursor-pointer items-start gap-3 px-3 py-2.5 outline-none transition-none focus-visible:bg-[color-mix(in_srgb,var(--ok-neon)_20%,transparent)] focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-[var(--ink)] ${
                  checked ? 'bg-[color-mix(in_srgb,var(--ok-neon)_20%,transparent)]' : 'hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)]'
                } ${readOnly ? 'cursor-default opacity-70' : ''}`}
              >
                {/* Marker: square = checkbox, square-with-dot = radio */}
                <span
                  aria-hidden="true"
                  className="mt-[2px] flex h-4 w-4 flex-shrink-0 items-center justify-center border-[2px] border-[var(--ink)] bg-[var(--surface-raised)]"
                >
                  {checked && (
                    <span className="block h-2 w-2 bg-[var(--ok-neon)] ring-1 ring-[var(--ink)]" />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-black uppercase tracking-[0.03em] text-[var(--ink)]">
                      {candidate.name}
                    </span>
                    <span
                      className="tag-label"
                      style={
                        isCorporate
                          ? { background: 'var(--danger-strong)', color: 'var(--bg)' }
                          : undefined
                      }
                    >
                      {isCorporate ? 'Corporate' : 'Individual'}
                    </span>
                    {multi && order > 0 && (
                      <span
                        className="tag-label"
                        style={{ background: 'var(--ok-strong)' }}
                      >
                        #{order}
                      </span>
                    )}
                  </span>
                  {(candidate.identifier || candidate.subtitle) && (
                    <span className="mt-0.5 block text-[11px] text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
                      {[candidate.identifier, candidate.subtitle]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </span>
              </div>

              {/* Second-level: a corporate party signs THROUGH a representative */}
              {isCorporate && checked && (
                <div className="ml-[26px] border-l-[3px] border-[var(--danger-strong)] bg-[color-mix(in_srgb,var(--ink)_4%,transparent)] px-3 py-2">
                  <span className="tag-label">Signs through</span>
                  {reps.length === 0 ? (
                    <p className="mt-1 text-[11px] font-bold text-[var(--danger-strong)]">
                      No representative directors on record for{' '}
                      {candidate.name}. Ask the agent to look them up.
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
                            className={`flex cursor-pointer items-center gap-2 px-1 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-[var(--ink)] ${
                              repChecked ? 'bg-[color-mix(in_srgb,var(--ok-neon)_25%,transparent)]' : ''
                            } ${readOnly ? 'cursor-default' : ''}`}
                          >
                            <span
                              aria-hidden="true"
                              className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border-[2px] border-[var(--ink)] bg-[var(--surface-raised)]"
                            >
                              {repChecked && (
                                <span className="block h-1.5 w-1.5 bg-[var(--danger-strong)]" />
                              )}
                            </span>
                            <span className="text-[12px] font-bold text-[var(--ink)]">
                              {rep.name}
                              {rep.identifier || rep.subtitle ? (
                                <span className="font-normal text-[color-mix(in_srgb,var(--ink)_60%,transparent)]">
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

      {/* Enter someone new */}
      {payload.allow_new && newFields.length > 0 && status === 'pending' && (
        <div className="border-t-[2px] border-[color-mix(in_srgb,var(--ink)_20%,transparent)] px-3 py-2">
          <button
            type="button"
            disabled={readOnly}
            aria-expanded={newOpen}
            onClick={() => {
              setNewOpen((open) => !open)
              setSelectedIds([])
            }}
            className="stamp-press border-[2px] border-b-[3px] border-r-[3px] border-[var(--ink)] bg-[var(--surface-raised)] px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-[var(--ink)] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--ink)] disabled:opacity-40"
          >
            {newOpen ? '− Cancel new entry' : '+ Enter someone new'}
          </button>

          {newOpen && (
            <div className="mt-2 flex flex-col gap-2">
              {newFields.map((field) => (
                <label key={field.name} className="flex flex-col gap-1">
                  <span className="tag-label">
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
                    className="border-[2px] border-b-[3px] border-r-[3px] border-[var(--ink)] bg-[var(--surface-raised)] px-2 py-1 text-[12px] font-bold text-[var(--ink)] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--ok-neon)]"
                    style={{ borderRadius: 0 }}
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      {status === 'pending' && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t-[2px] border-[var(--ink)] px-3 py-2">
          <span
            className="text-[10px] font-bold uppercase tracking-[0.1em] text-[color-mix(in_srgb,var(--ink)_60%,transparent)]"
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
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="stamp-press border-[2px] border-b-[3px] border-r-[3px] border-[var(--ink)] bg-[var(--ok-neon)] px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.1em] text-[var(--ink)] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--ink)] disabled:cursor-not-allowed disabled:bg-[color-mix(in_srgb,var(--ink)_10%,transparent)] disabled:text-[color-mix(in_srgb,var(--ink)_40%,transparent)]"
            style={{ borderRadius: 0 }}
          >
            {submitting ? 'Sending…' : 'Confirm'}
          </button>
        </footer>
      )}
    </section>
  )
}

export default PickerCard
