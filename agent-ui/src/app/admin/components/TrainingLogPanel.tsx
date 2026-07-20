'use client'

import { useEffect, useRef } from 'react'
import { Brain, CheckCircle2, X } from 'lucide-react'
import { Badge, IconButton } from '@/components/ui/kit'
import { cn } from '@/lib/utils'

export interface TrainingLogLine {
  time: string
  msg: string
  type: string
}

const LINE_TONE: Record<string, string> = {
  success: 'text-[var(--ok-strong)]',
  error: 'text-[var(--danger-strong)]',
  processing: 'text-[var(--warn)]',
  ai: 'text-[var(--brand)]'
}

/**
 * Docked console for the streaming training runs. Deliberately a log, not a
 * progress bar: an operator watching a long AI job wants the transcript, and
 * wants to keep working while it runs — so it docks rather than taking a modal.
 */
export function TrainingLogPanel({
  open,
  onClose,
  title,
  logs,
  running,
  complete
}: {
  open: boolean
  onClose: () => void
  title: string
  logs: TrainingLogLine[]
  running: boolean
  complete: boolean
}) {
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Follow the tail while the run is live.
    if (running) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [logs.length, running])

  if (!open) return null

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label={title}
      className={cn(
        'fixed bottom-4 right-4 z-50 w-[min(32rem,calc(100vw-2rem))] max-h-[70vh] flex flex-col',
        'bg-[var(--surface)] border border-[var(--border-strong)] rounded-[var(--radius-sm)]',
        'shadow-[0_16px_48px_-12px_rgba(0,0,0,0.35)]'
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 min-w-0">
          <Brain className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          <span className="font-[family-name:var(--font-display)] text-[length:var(--text-sm)] font-semibold text-[var(--text)] truncate">
            {title}
          </span>
          {running && (
            <Badge tone="warn" dot>
              Running
            </Badge>
          )}
          {complete && !running && (
            <Badge tone="ok" dot>
              Complete
            </Badge>
          )}
        </div>
        <IconButton aria-label="Close training log" onClick={onClose} icon={<X className="w-4 h-4" />} />
      </div>

      <div
        ref={bodyRef}
        className="flex-1 overflow-y-auto px-3.5 py-2.5 font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] leading-5 bg-[var(--bg-secondary)]"
      >
        {logs.length === 0 ? (
          <p className="py-8 text-center text-[var(--text-muted)]">
            No run yet. Start training to see the transcript here.
          </p>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-[var(--text-muted)] shrink-0 tabular-nums">{log.time}</span>
              <span className={cn('whitespace-pre-wrap break-words', LINE_TONE[log.type] ?? 'text-[var(--text-secondary)]')}>
                {log.msg}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between px-3.5 py-2 border-t border-[var(--border)] text-[length:var(--text-2xs)] text-[var(--text-muted)]">
        <span className="tabular-nums">{logs.length} entries</span>
        {complete && (
          <span className="inline-flex items-center gap-1 text-[var(--ok-strong)]">
            <CheckCircle2 className="w-3 h-3" /> Finished
          </span>
        )}
      </div>
    </div>
  )
}
