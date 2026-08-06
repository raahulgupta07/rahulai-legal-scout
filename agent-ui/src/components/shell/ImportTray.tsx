'use client'

/**
 * Docked import tray — the bottom-right panel that reports what happened to
 * each dropped DICA extract.
 *
 * Mounted once by AppShell so a batch keeps running while the operator moves
 * between Templates, Companies and People. Collapses to a single-line pill;
 * dismissing it hides the panel without cancelling the run.
 */

import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Copy,
  Loader2,
  X,
  XCircle,
} from 'lucide-react'
import { useImportQueue, importSummary, type ImportItem } from '@/hooks/useImportQueue'
import { useImportRunner } from '@/hooks/useImportRunner'

const RUNNING: ImportItem['status'][] = ['uploading', 'extracting', 'saving']

function StatusIcon({ status }: { status: ImportItem['status'] }) {
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

export default function ImportTray() {
  useImportRunner()

  const router = useRouter()
  const items = useImportQueue((s) => s.items)
  const open = useImportQueue((s) => s.open)
  const collapsed = useImportQueue((s) => s.collapsed)
  const setOpen = useImportQueue((s) => s.setOpen)
  const setCollapsed = useImportQueue((s) => s.setCollapsed)
  const remove = useImportQueue((s) => s.remove)
  const update = useImportQueue((s) => s.update)
  const clearFinished = useImportQueue((s) => s.clearFinished)

  if (!open || items.length === 0) return null

  const s = importSummary(items)
  const active = s.running + s.queued

  const summaryLine = [
    s.saved && `${s.saved} saved`,
    s.running && `${s.running} running`,
    s.queued && `${s.queued} queued`,
    s.review && `${s.review} to review`,
    s.failed && `${s.failed} failed`,
  ]
    .filter(Boolean)
    .join(' · ')

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-[12px] font-medium text-[var(--text)] shadow-lg hover:bg-[var(--bg-secondary)]"
      >
        {active > 0 ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--brand)]" />
        ) : (
          <Check className="h-3.5 w-3.5 text-[var(--ok-strong,#15803d)]" />
        )}
        {active > 0 ? `Importing ${active} file${active === 1 ? '' : 's'}` : 'Import finished'}
        <span className="text-[var(--text-muted)]">— {summaryLine}</span>
        <ChevronUp className="h-3.5 w-3.5 opacity-60" />
      </button>
    )
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex max-h-[70vh] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[var(--radius-lg,12px)] border border-[var(--border)] bg-[var(--surface)] shadow-xl">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3.5 py-2.5">
        <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--text)]">
          {active > 0 && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--brand)]" />}
          {active > 0
            ? `Importing ${active} file${active === 1 ? '' : 's'}`
            : `Imported ${items.length} file${items.length === 1 ? '' : 's'}`}
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Collapse"
            onClick={() => setCollapsed(true)}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-[var(--text)]"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {items.map((it) => (
          <div key={it.id} className="border-b border-[var(--border)] px-3.5 py-2.5 last:border-b-0">
            <div className="flex items-start gap-2">
              <span className="mt-0.5">
                <StatusIcon status={it.status} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium text-[var(--text)]" title={it.fileName}>
                  {it.companyName || it.fileName}
                </p>
                <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                  {it.status === 'saved' && (it.directors || it.members)
                    ? `Saved · ${it.directors} director${it.directors === 1 ? '' : 's'}, ${it.members} member${it.members === 1 ? '' : 's'}`
                    : it.stage}
                </p>

                {RUNNING.includes(it.status) && (
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--accent)]">
                    <div
                      className="h-full rounded-full bg-[var(--brand)] transition-[width] duration-300"
                      style={{ width: `${Math.max(4, it.progress)}%` }}
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
                        onClick={() => update(it.id, { status: 'queued', stage: 'Queued', progress: 0, error: undefined })}
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
        ))}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-2">
        <span className="truncate text-[11.5px] text-[var(--text-muted)]">{summaryLine || 'Starting…'}</span>
        {active === 0 && (
          <button
            type="button"
            onClick={clearFinished}
            className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium text-[var(--brand)] hover:bg-[var(--accent)]"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
