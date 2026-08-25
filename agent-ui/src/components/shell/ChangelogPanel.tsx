'use client'

/**
 * "What's new" — the panel behind the version number in the rail footer.
 *
 * Content is parsed server-side by GET /api/changelog, so no markdown library
 * ships in the bundle. The version the SERVER reports is badged as running:
 * the API and this frontend can come from different images, and this is the
 * only place in the interface where that difference would be visible.
 */

import { useEffect, useRef, useState } from 'react'
import { X, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { focusRing } from '@/components/ui/kit'

interface Section {
  title: string
  items: string[]
}
interface Version {
  version: string
  date: string
  running: boolean
  sections: Section[]
}

/** Versions expanded on open. The rest collapse — 1.2.0 alone carries 17
 *  entries, and expanding everything buries whatever shipped most recently. */
const EXPANDED_BY_DEFAULT = 2

export default function ChangelogPanel({ onClose }: { onClose: () => void }) {
  const [versions, setVersions] = useState<Version[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const tok =
          typeof window !== 'undefined' ? localStorage.getItem('ls_token') || '' : ''
        const res = await fetch(
          '/api/changelog',
          tok ? { headers: { Authorization: `Bearer ${tok}` } } : {}
        )
        const data = await res.json()
        if (cancelled) return
        if (!res.ok || !data?.success) {
          setError(data?.error || `Changelog unavailable (${res.status})`)
        } else {
          const list: Version[] = data.versions || []
          setVersions(list)
          const init: Record<string, boolean> = {}
          list.forEach((v, i) => {
            init[v.version] = i < EXPANDED_BY_DEFAULT
          })
          setOpen(init)
        }
      } catch {
        if (!cancelled) setError('Changelog unavailable')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-title"
        className="flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <h2 id="changelog-title" className="text-[14px] font-semibold">
            What&rsquo;s new
          </h2>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className={cn(
              'rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
              focusRing
            )}
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {/* The panel scrolls; the page behind it never does. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <p className="text-[13px] text-[var(--text-muted)]">Loading&hellip;</p>
          )}
          {error && !loading && (
            <p className="text-[13px] text-[var(--text-muted)]">{error}</p>
          )}
          {!loading &&
            !error &&
            versions.map((v) => {
              const isOpen = !!open[v.version]
              return (
                <section key={v.version} className="mb-5 last:mb-0">
                  <button
                    onClick={() =>
                      setOpen((s) => ({ ...s, [v.version]: !s[v.version] }))
                    }
                    aria-expanded={isOpen}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md py-1 text-left',
                      focusRing
                    )}
                  >
                    <ChevronRight
                      size={14}
                      aria-hidden
                      className={cn(
                        'shrink-0 text-[var(--text-muted)] transition-transform',
                        isOpen && 'rotate-90'
                      )}
                    />
                    <span className="text-[13px] font-semibold tabular-nums">
                      {v.version}
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {v.date}
                    </span>
                    {v.running && (
                      <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft,rgba(37,99,235,0.1))] px-2 py-0.5 text-[10px] font-medium text-[var(--brand)]">
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]"
                          aria-hidden
                        />
                        running
                      </span>
                    )}
                  </button>

                  {isOpen && (
                    <div className="mt-1 pl-6">
                      {v.sections.map((s, si) => (
                        <div key={si} className="mb-3 last:mb-0">
                          {s.title && (
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]">
                              {s.title}
                            </p>
                          )}
                          <ul className="space-y-1.5">
                            {s.items.map((it, ii) => (
                              <li
                                key={ii}
                                className="text-[13px] leading-[1.5] text-[var(--text)]"
                              >
                                <span
                                  className="mr-2 text-[var(--text-muted)]"
                                  aria-hidden
                                >
                                  &bull;
                                </span>
                                {it}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
        </div>
      </div>
    </div>
  )
}
