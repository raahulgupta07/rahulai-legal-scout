'use client'

import { AlertTriangle, Check, Loader2, Minus, X } from 'lucide-react'
import { Badge } from '@/components/ui/kit'
import { cn } from '@/lib/utils'

/**
 * The 15-step training pipeline, as a live tracker.
 *
 * A raw SSE transcript tells an operator that *something* is happening; it does
 * not tell them how far through they are or which stage went wrong. So the
 * stream is folded onto the known pipeline: every step is listed up front, and
 * each one lights up as its events arrive. The transcript stays available
 * underneath for the detail.
 */
export type StepStatus = 'pending' | 'running' | 'done' | 'warn' | 'error'

export interface PipelineStep {
  /** Display number — 5.5 is a real half-step in this pipeline. */
  num: string
  key: string
  name: string
  /** What it produces, shown while pending. */
  detail: string
  status: StepStatus
  /** Latest message from the stream for this step. */
  note?: string
}

/**
 * Maps an SSE `step` key onto a pipeline row. Keys arrive as `<key>`,
 * `<key>_start` and `<key>_warn`, so the suffix carries the status.
 */
export const STEP_DEFS: { num: string; key: string; name: string; detail: string; matches: string[] }[] = [
  { num: '1', key: 'extract', name: 'Extract placeholders', detail: 'Regex scan of the .docx', matches: ['extract', 'field_found'] },
  { num: '2', key: 'read', name: 'Read document text', detail: 'Paragraphs and tables', matches: ['read'] },
  { num: '3', key: 'ai', name: 'AI analysis', detail: 'Category, purpose, legal refs', matches: ['ai', 'ai_analysis'] },
  { num: '4', key: 'metadata', name: 'Save metadata', detail: '37 columns on the template', matches: ['metadata', 'save'] },
  { num: '5', key: 'classify', name: 'Classify fields', detail: 'Auto-fill vs user input', matches: ['classify'] },
  { num: '5.5', key: 'mapping', name: 'Map to DB columns', detail: 'Placeholder → exact column', matches: ['mapping'] },
  { num: '6', key: 'knowledge', name: 'Store knowledge', detail: 'Lookup + vector entries', matches: ['knowledge', 'kb'] },
  { num: '7', key: 'embedding', name: 'Generate embedding', detail: '1536-dim vector', matches: ['embedding', 'embed'] },
  { num: '8', key: 'pdf', name: 'Build PDF preview', detail: 'Placeholders highlighted', matches: ['pdf'] },
  { num: '9', key: 'field_deep', name: 'Field deep analysis', detail: 'Type, format, validation', matches: ['field_deep', 'field_detail'] },
  { num: '10', key: 'legal_ref', name: 'Legal references', detail: 'Myanmar Companies Law 2017', matches: ['legal_ref'] },
  { num: '11', key: 'sample', name: 'Sample document', detail: 'Realistic filled example', matches: ['sample'] },
  { num: '12', key: 'workflow', name: 'Document workflow', detail: 'Trigger, before, after', matches: ['workflow'] },
  { num: '13', key: 'qa', name: 'Q&A pairs', detail: '10 practical questions', matches: ['qa'] },
  { num: '14', key: 'cross_ref', name: 'Cross-template links', detail: 'Prerequisites and follow-ups', matches: ['cross_ref'] },
  { num: '15', key: 'confidence', name: 'Confidence score', detail: 'Based on steps that passed', matches: ['confidence'] }
]

export const freshSteps = (): PipelineStep[] =>
  STEP_DEFS.map((d) => ({ num: d.num, key: d.key, name: d.name, detail: d.detail, status: 'pending' }))

/**
 * Folds one SSE event into the step list. Returns a new array when something
 * changed, and the same reference when the event is not a pipeline event —
 * so React can skip the re-render.
 */
export function applyStepEvent(steps: PipelineStep[], rawKey: string, msg: string): PipelineStep[] {
  if (!rawKey) return steps

  const base = rawKey.replace(/_(start|warn|skip|done)$/, '')
  const def = STEP_DEFS.find((d) => d.matches.includes(base) || d.matches.includes(rawKey))
  if (!def) return steps

  let status: StepStatus
  if (rawKey.endsWith('_start')) status = 'running'
  else if (rawKey.endsWith('_warn') || rawKey.endsWith('_skip')) status = 'warn'
  else status = 'done'

  return steps.map((s) => {
    if (s.key !== def.key) return s
    // A warning must not be overwritten by a later plain event for the
    // same step — a degraded step should still read as degraded.
    if (s.status === 'warn' && status === 'done') return { ...s, note: msg || s.note }
    return { ...s, status, note: msg || s.note }
  })
}

const STATUS_ICON: Record<StepStatus, React.ReactNode> = {
  pending: <Minus className="w-3 h-3" />,
  running: <Loader2 className="w-3 h-3 animate-spin" />,
  done: <Check className="w-3 h-3" />,
  warn: <AlertTriangle className="w-3 h-3" />,
  error: <X className="w-3 h-3" />
}

const STATUS_STYLE: Record<StepStatus, string> = {
  pending: 'border-[var(--border)] text-[var(--text-muted)]',
  running: 'border-[var(--brand)] text-[var(--brand)]',
  done: 'border-[color-mix(in_srgb,var(--ok-strong)_45%,transparent)] text-[var(--ok-strong)]',
  warn: 'border-[color-mix(in_srgb,var(--warn)_55%,transparent)] text-[var(--warn)]',
  error: 'border-[color-mix(in_srgb,var(--danger-strong)_45%,transparent)] text-[var(--danger-strong)]'
}

export function TrainingProgress({
  steps,
  templateName,
  index,
  total,
  running
}: {
  steps: PipelineStep[]
  templateName?: string
  /** 1-based position in the training queue. */
  index?: number
  total?: number
  running: boolean
}) {
  const done = steps.filter((s) => s.status === 'done' || s.status === 'warn').length
  const pct = Math.round((done / steps.length) * 100)
  const failed = steps.filter((s) => s.status === 'warn' || s.status === 'error').length

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-sm)]">
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="font-[family-name:var(--font-display)] text-[length:var(--text-sm)] font-semibold text-[var(--text)] truncate">
              {templateName || 'Training pipeline'}
            </p>
            <p className="mt-0.5 text-[length:var(--text-2xs)] text-[var(--text-muted)]">
              {index && total ? `Template ${index} of ${total} · ` : ''}
              {done} of {steps.length} steps
              {failed > 0 && ` · ${failed} degraded`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {failed > 0 && (
              <Badge tone="warn" dot>
                {failed} degraded
              </Badge>
            )}
            <span className="font-[family-name:var(--font-display)] text-[length:var(--text-xl)] font-semibold tabular-nums text-[var(--text)]">
              {pct}%
            </span>
          </div>
        </div>

        <div
          className="mt-2.5 h-1 w-full bg-[var(--bg-secondary)] overflow-hidden"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Training progress"
        >
          <div
            className="h-full transition-[width] duration-300"
            style={{
              width: `${pct}%`,
              background: failed > 0 ? 'var(--warn)' : running ? 'var(--brand)' : 'var(--ok-strong)'
            }}
          />
        </div>
      </div>

      <ol className="divide-y divide-[var(--border)]">
        {steps.map((s) => (
          <li
            key={s.key}
            className={cn(
              'flex items-start gap-3 px-4 py-2',
              s.status === 'running' && 'bg-[var(--bg-secondary)]'
            )}
          >
            <span
              className={cn(
                'mt-0.5 w-5 h-5 shrink-0 grid place-items-center border rounded-[var(--radius-sm)]',
                STATUS_STYLE[s.status]
              )}
              aria-hidden
            >
              {STATUS_ICON[s.status]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="text-[length:var(--text-2xs)] tabular-nums text-[var(--text-muted)] w-6 shrink-0">
                  {s.num}
                </span>
                <span
                  className={cn(
                    'text-[length:var(--text-sm)] truncate',
                    s.status === 'pending' ? 'text-[var(--text-muted)]' : 'text-[var(--text)] font-medium'
                  )}
                >
                  {s.name}
                </span>
              </span>
              <span className="block pl-8 text-[length:var(--text-2xs)] text-[var(--text-muted)] truncate">
                {s.note || s.detail}
              </span>
            </span>
            <span className="sr-only">{s.status}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
