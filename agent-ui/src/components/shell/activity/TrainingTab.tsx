'use client'

/**
 * Training channel of the activity tray.
 *
 * Training used to be watchable only from a modal that covered the Templates
 * page — the work ran in the background but the *reporting* did not, so
 * following it meant not using the app. Here it is a channel like any other:
 * queue position, a percentage for the queue and a percentage for the template
 * in flight, and the step it is on.
 *
 * Every number comes from the same job poll and the same step fold the modal
 * uses, so the two cannot disagree.
 */

import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, Minus, Square, X } from 'lucide-react'
import apiClient, { authFetch } from '@/lib/api-client'
import {
  useTrainingJob,
  stepsFromJob,
  trainingSummary,
  isTrainingActive,
} from '@/hooks/useTrainingJob'
import type { StepStatus } from '@/app/admin/components/TrainingProgress'

const STEP_ICON: Record<StepStatus, React.ReactNode> = {
  pending: <Minus className="h-3 w-3 text-[var(--faint,#9CA3AF)]" />,
  running: <Loader2 className="h-3 w-3 animate-spin text-[var(--brand)]" />,
  done: <Check className="h-3 w-3 text-[var(--ok-strong,#15803d)]" />,
  warn: <AlertTriangle className="h-3 w-3 text-[var(--warn)]" />,
  error: <X className="h-3 w-3 text-[var(--danger-strong,#b91c1c)]" />,
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--accent)]">
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${Math.max(2, pct)}%`, background: tone }}
      />
    </div>
  )
}

export default function TrainingTab() {
  const job = useTrainingJob((s) => s.job)
  const [showSteps, setShowSteps] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  if (!job) {
    return (
      <p className="px-3.5 py-6 text-center text-[11.5px] text-[var(--text-muted)]">
        No training run. Upload a template, or use Train agent on the Templates register.
      </p>
    )
  }

  const steps = stepsFromJob(job)
  const s = trainingSummary(job, steps)
  const running = isTrainingActive(job)
  const current = steps.find((x) => x.status === 'running')

  const cancel = async () => {
    setCancelling(true)
    try {
      await authFetch(apiClient.trainCancel(), { method: 'POST' })
    } catch (e) {
      console.error('Cancel training failed:', e)
    } finally {
      setCancelling(false)
    }
  }

  const queueTone = s.failed > 0 ? 'var(--warn)' : running ? 'var(--brand)' : 'var(--ok-strong)'

  return (
    <div className="px-3.5 py-2.5">
      {/* Whole queue */}
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-[12.5px] font-medium text-[var(--text)]">{s.label}</p>
        <span className="shrink-0 text-[12.5px] font-medium tabular-nums text-[var(--text)]">{s.pct}%</span>
      </div>
      <Bar pct={s.pct} tone={queueTone} />
      <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
        {s.finished} of {s.total} templates
        {s.failed > 0 && ` · ${s.failed} failed`}
      </p>

      {/* Template in flight */}
      {running && s.templateName && (
        <div className="mt-3 rounded-[var(--radius-md,8px)] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="min-w-0 truncate text-[11.5px] font-medium text-[var(--text)]" title={s.templateName}>
              {s.templateName}
            </p>
            <span className="shrink-0 text-[11.5px] font-medium tabular-nums text-[var(--brand)]">
              {s.stepPct}%
            </span>
          </div>
          <Bar pct={s.stepPct} tone="var(--brand)" />
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--brand)]" />
            <span className="min-w-0 truncate">
              Step {current?.num || s.stepsDone} of {s.stepsTotal} · {current?.name || 'Starting'}
            </span>
          </p>
        </div>
      )}

      {job.status === 'error' && job.error && (
        <p className="mt-2 text-[11.5px] text-[var(--danger-strong,#b91c1c)]">{job.error}</p>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setShowSteps((v) => !v)}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-[var(--text)]"
        >
          {showSteps ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {showSteps ? 'Hide steps' : `Steps (${s.stepsDone}/${s.stepsTotal})`}
        </button>
        {running && (
          <button
            type="button"
            onClick={cancel}
            disabled={cancelling}
            className="ml-auto flex items-center gap-1 rounded border border-[var(--border-strong,var(--border))] px-2 py-0.5 text-[11px] font-medium text-[var(--danger-strong,#b91c1c)] hover:bg-[var(--accent)] disabled:opacity-50"
            title="Stops after the template currently being trained"
          >
            <Square className="h-3 w-3" />
            {cancelling ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>

      {showSteps && (
        <ol className="mt-1.5 border-t border-[var(--border)]">
          {steps.map((st) => (
            <li key={st.key} className="flex items-baseline gap-2 py-1">
              <span className="mt-0.5 shrink-0 self-start">{STEP_ICON[st.status]}</span>
              <span className="w-6 shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{st.num}</span>
              <span
                className={
                  st.status === 'pending'
                    ? 'min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-muted)]'
                    : 'min-w-0 flex-1 truncate text-[11.5px] text-[var(--text)]'
                }
              >
                {st.name}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
