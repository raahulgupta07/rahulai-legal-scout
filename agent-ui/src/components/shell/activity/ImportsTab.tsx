'use client'

/**
 * Imports channel of the activity tray — one row per dropped DICA extract,
 * reporting what happened to it.
 *
 * Split out of the old standalone ImportTray unchanged in behaviour: the same
 * statuses, the same Open / Update existing / Retry / Remove actions. What is
 * new is the number beside the bar — "Extracting with AI" alone never said how
 * far in it was.
 */

import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, CircleDashed, Copy, Loader2, XCircle } from 'lucide-react'
import { useImportQueue, importSummary, type ImportItem } from '@/hooks/useImportQueue'

const RUNNING: ImportItem['status'][] = ['uploading', 'extracting', 'saving']

export function StatusIcon({ status }: { status: ImportItem['status'] }) {
  if (RUNNING.includes(status))
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--brand)]" />
  if (status === 'saved')
    return <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ok-strong,#15803d)]" />
  if (status === 'failed')
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-[var(--danger-strong,#b91c1c)]" />
  if (status === 'duplicate')
    return <Copy className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
  if (status === 'review')
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--warn)]" />
  return <CircleDashed className="h-3.5 w-3.5 shrink-0 text-[var(--faint,#9CA3AF)]" />
}

/** Footer line for the imports channel. */
export function importsFooterLine(items: ImportItem[]) {
  const s = importSummary(items)
  return [
    s.saved && `${s.saved} saved`,
    s.running && `${s.running} running`,
    s.queued && `${s.queued} queued`,
    s.review && `${s.review} to review`,
    s.failed && `${s.failed} failed`,
  ]
    .filter(Boolean)
    .join(' · ')
}

export default function ImportsTab() {
  const router = useRouter()
  const items = useImportQueue((s) => s.items)
  const remove = useImportQueue((s) => s.remove)
  const update = useImportQueue((s) => s.update)

  if (items.length === 0) {
    return (
      <p className="px-3.5 py-6 text-center text-[11.5px] text-[var(--text-muted)]">
        No imports running. Drop DICA extracts on the Companies register to start one.
      </p>
    )
  }

  return (
    <>
      {items.map((it) => {
        const running = RUNNING.includes(it.status)
        const pct = Math.min(100, Math.max(0, Math.round(it.progress)))
        return (
          <div key={it.id} className="border-b border-[var(--border)] px-3.5 py-2.5 last:border-b-0">
            <div className="flex items-start gap-2">
              <span className="mt-0.5">
                <StatusIcon status={it.status} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium text-[var(--text)]" title={it.fileName}>
                  {it.companyName || it.fileName}
                </p>
                <p className="mt-0.5 flex items-baseline gap-1.5 text-[11.5px] text-[var(--text-muted)]">
                  <span className="min-w-0 flex-1 truncate">
                    {it.status === 'saved' && (it.directors || it.members)
                      ? `Saved · ${it.directors} director${it.directors === 1 ? '' : 's'}, ${it.members} member${it.members === 1 ? '' : 's'}`
                      : it.stage}
                  </span>
                  {running && (
                    <span className="shrink-0 tabular-nums font-medium text-[var(--brand)]">{pct}%</span>
                  )}
                </p>

                {running && (
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--accent)]">
                    <div
                      className="h-full rounded-full bg-[var(--brand)] transition-[width] duration-300"
                      style={{ width: `${Math.max(4, pct)}%` }}
                    />
                  </div>
                )}

                {(it.status === 'review' || it.status === 'duplicate' || it.status === 'failed') && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {(it.status === 'review' || it.status === 'duplicate') && (
                      <button
                        type="button"
                        onClick={() => {
                          // Hand the extracted record to the normal review
                          // screen rather than duplicating the form here.
                          try {
                            sessionStorage.setItem('ls_import_review', JSON.stringify(it.data ?? {}))
                          } catch (e) {
                            console.error('Could not stage import for review:', e)
                          }
                          router.push('/admin/registers?tab=companies&review=1')
                        }}
                        className="rounded border border-[var(--border-strong,var(--border))] px-2 py-0.5 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--accent)]"
                      >
                        Open
                      </button>
                    )}
                    {it.status === 'duplicate' && (
                      <button
                        type="button"
                        onClick={() => update(it.id, { status: 'queued', stage: 'Queued', progress: 0 })}
                        className="rounded border border-[var(--border-strong,var(--border))] px-2 py-0.5 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--accent)]"
                        title="Re-run and overwrite the record already on file"
                      >
                        Update existing
                      </button>
                    )}
                    {it.status === 'failed' && (
                      <button
                        type="button"
                        onClick={() =>
                          update(it.id, { status: 'queued', stage: 'Queued', progress: 0, error: undefined })
                        }
                        className="rounded border border-[var(--border-strong,var(--border))] px-2 py-0.5 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--accent)]"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(it.id)}
                      className="rounded px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-[var(--text)]"
                    >
                      {it.status === 'duplicate' ? 'Skip' : 'Remove'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
