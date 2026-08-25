'use client'

/**
 * The docked activity tray — one panel, bottom right, for every piece of work
 * that runs without the operator watching it.
 *
 * It replaces the standalone import tray and the blocking training modal. The
 * modal was the real problem: training already survived the tab closing, but
 * the only way to SEE it covered the page it was training from. Same panel,
 * same corner, same collapsed pill as the import tray always had — the one new
 * element is the tab strip, which uses the underline the admin tabs use.
 *
 * Mounted once by AppShell so a batch, a training run and a queued email all
 * keep reporting while the operator moves between Chat, Templates and People.
 */

import { useEffect, useRef } from 'react'
import { Check, ChevronDown, ChevronUp, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useImportQueue, importSummary } from '@/hooks/useImportQueue'
import { useImportRunner } from '@/hooks/useImportRunner'
import { useActivityTray, type ActivityTab } from '@/hooks/useActivityTray'
import {
  useTrainingJob,
  useTrainingJobPoller,
  stepsFromJob,
  trainingSummary,
  isTrainingActive,
} from '@/hooks/useTrainingJob'
import { useEmailQueue, useEmailQueuePoller } from '@/hooks/useEmailQueue'
import ImportsTab, { importsFooterLine } from './activity/ImportsTab'
import TrainingTab from './activity/TrainingTab'
import EmailTab from './activity/EmailTab'

export default function ActivityTray() {
  useImportRunner()
  useTrainingJobPoller()
  useEmailQueuePoller()

  const items = useImportQueue((s) => s.items)
  const clearFinished = useImportQueue((s) => s.clearFinished)
  const job = useTrainingJob((s) => s.job)
  const emails = useEmailQueue((s) => s.items)

  const tab = useActivityTray((s) => s.tab)
  const dismissed = useActivityTray((s) => s.dismissed)
  const forced = useActivityTray((s) => s.forced)
  const collapsed = useActivityTray((s) => s.collapsed)
  const setTab = useActivityTray((s) => s.setTab)
  const suggestTab = useActivityTray((s) => s.suggestTab)
  const dismiss = useActivityTray((s) => s.dismiss)
  const revive = useActivityTray((s) => s.revive)
  const setCollapsed = useActivityTray((s) => s.setCollapsed)

  const imports = importSummary(items)
  const importsActive = imports.running + imports.queued
  const steps = stepsFromJob(job)
  const training = trainingSummary(job, steps)
  const trainingActive = isTrainingActive(job)

  // New work revives a dismissed tray. A dismissal answered for what the
  // operator had already seen — not for a batch that starts afterwards.
  const seenRef = useRef({ imports: 0, emails: 0, job: '' })
  useEffect(() => {
    const now = { imports: items.length, emails: emails.length, job: job?.status || '' }
    const prev = seenRef.current
    if (now.imports > prev.imports) {
      revive()
      suggestTab('imports')
    }
    if (now.job && now.job !== prev.job && (now.job === 'running' || now.job === 'queued')) {
      revive()
      suggestTab('training')
    }
    if (now.emails > prev.emails) {
      revive()
      suggestTab('email')
    }
    seenRef.current = now
  }, [items.length, emails.length, job?.status, revive, suggestTab])

  const hasWork = items.length > 0 || !!job || emails.length > 0
  if ((!hasWork && !forced) || dismissed) return null

  const anyActive = importsActive > 0 || trainingActive

  const headline = trainingActive
    ? training.label
    : importsActive > 0
      ? `Importing ${importsActive} file${importsActive === 1 ? '' : 's'}`
      : emails.length > 0
        ? `${emails.length} email${emails.length === 1 ? '' : 's'} to approve`
        : 'Activity'

  const headPct = trainingActive
    ? training.pct
    : importsActive > 0
      ? Math.round((imports.saved / Math.max(1, items.length)) * 100)
      : null

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-[12px] font-medium text-[var(--text)] shadow-lg hover:bg-[var(--bg-secondary)]"
      >
        {anyActive ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--brand)]" />
        ) : (
          <Check className="h-3.5 w-3.5 text-[var(--ok-strong,#15803d)]" />
        )}
        {headline}
        {headPct !== null && (
          <span className="tabular-nums text-[var(--brand)]">{headPct}%</span>
        )}
        <ChevronUp className="h-3.5 w-3.5 opacity-60" />
      </button>
    )
  }

  const TABS: { id: ActivityTab; label: string; count: number; live: boolean }[] = [
    { id: 'imports', label: 'Imports', count: items.length, live: importsActive > 0 },
    { id: 'training', label: 'Training', count: job ? training.total : 0, live: trainingActive },
    { id: 'email', label: 'Email', count: emails.length, live: false },
  ]

  const footerLine =
    tab === 'imports'
      ? importsFooterLine(items) || (items.length ? 'Starting…' : 'Nothing queued')
      : tab === 'training'
        ? job
          ? `${training.finished} of ${training.total} templates${training.failed ? ` · ${training.failed} failed` : ''}`
          : 'No training run'
        : emails.length
          ? `${emails.length} awaiting approval`
          : 'Nothing waiting'

  return (
    <div className="fixed bottom-4 right-4 z-40 flex max-h-[70vh] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[var(--radius-lg,12px)] border border-[var(--border)] bg-[var(--surface)] shadow-xl">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3.5 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--text)]">
          {anyActive && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--brand)]" />}
          <span className="truncate">{headline}</span>
          {headPct !== null && (
            <span className="shrink-0 tabular-nums text-[var(--brand)]">{headPct}%</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
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
            onClick={dismiss}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </span>
      </div>

      {/* The one new element: the same 2px underline the admin tabs use. */}
      <div
        role="tablist"
        aria-label="Background activity"
        className="flex shrink-0 items-center gap-3.5 border-b border-[var(--border)] px-3.5"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 py-2 text-[12px] font-medium transition-colors',
              tab === t.id
                ? 'border-[var(--brand)] text-[var(--text)]'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
            )}
          >
            {t.label}
            {t.live ? (
              <Loader2 className="h-3 w-3 animate-spin text-[var(--brand)]" />
            ) : t.count > 0 ? (
              <span className="rounded-full bg-[var(--accent)] px-1.5 text-[10.5px] tabular-nums text-[var(--text-muted)]">
                {t.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {tab === 'imports' && <ImportsTab />}
        {tab === 'training' && <TrainingTab />}
        {tab === 'email' && <EmailTab />}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-2">
        <span className="truncate text-[11.5px] text-[var(--text-muted)]">{footerLine}</span>
        {tab === 'imports' && importsActive === 0 && items.length > 0 && (
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
