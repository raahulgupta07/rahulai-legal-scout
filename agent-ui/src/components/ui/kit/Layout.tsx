'use client'

import * as React from 'react'
import { Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { focusRing } from './Button'
import { controlBase } from './Field'
import { Badge, type Tone } from './Badge'

/**
 * Every admin screen is the same three bands: a header that never scrolls, an
 * optional toolbar, and a scrolling body. Consistent geography means an
 * operator's eye lands in the right place on every page.
 */
export function Page({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col h-full bg-[var(--bg-secondary)] min-w-0">{children}</div>
}

export function PageHeader({
  title,
  /** Short factual subtitle — a count, a scope, a last-synced time. */
  meta,
  description,
  actions,
  back
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  description?: string
  actions?: React.ReactNode
  back?: React.ReactNode
}) {
  return (
    <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3.5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-2.5 min-w-0">
          {back}
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="font-[family-name:var(--font-display)] text-[length:var(--text-lg)] font-semibold tracking-[-0.01em] text-[var(--text)] truncate">
                {title}
              </h1>
              {meta}
            </div>
            {description && (
              <p className="mt-1 text-[length:var(--text-xs)] text-[var(--text-muted)] max-w-2xl">{description}</p>
            )}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </header>
  )
}

export function Toolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'shrink-0 flex items-center gap-2 flex-wrap px-5 py-2.5',
        'border-b border-[var(--border)] bg-[var(--surface)]',
        className
      )}
    >
      {children}
    </div>
  )
}

export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex-1 overflow-y-auto min-w-0 px-5 py-4', className)}>{children}</div>
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  label,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  label: string
  className?: string
}) {
  return (
    <div className={cn('relative min-w-0 flex-1 max-w-sm', className)}>
      <Search
        className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none"
        aria-hidden
      />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(controlBase, 'pl-8 h-8 py-0')}
      />
    </div>
  )
}

export function Card({
  title,
  meta,
  actions,
  padded = true,
  className,
  children
}: {
  title?: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
  padded?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        'bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-sm)] min-w-0',
        className
      )}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[var(--border)]">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="font-[family-name:var(--font-display)] text-[length:var(--text-sm)] font-semibold text-[var(--text)] truncate">
              {title}
            </h2>
            {meta}
          </div>
          {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </section>
  )
}

/**
 * Summary before detail: a row of these sits above every list so the shape of
 * the data is legible before any row is read.
 */
export function StatTile({
  label,
  value,
  hint,
  tone,
  icon
}: {
  label: string
  value: React.ReactNode
  hint?: string
  /** Only pass a tone when the number *means* something is wrong or right. */
  tone?: Tone
  icon?: React.ReactNode
}) {
  const accent =
    tone === 'ok'
      ? 'var(--ok-strong)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'danger'
          ? 'var(--danger-strong)'
          : null

  return (
    <div
      className="relative bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-sm)] px-3.5 py-3 min-w-0"
      style={accent ? { boxShadow: `inset 3px 0 0 0 ${accent}` } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)] truncate">
          {label}
        </span>
        {icon && <span className="text-[var(--text-muted)] shrink-0">{icon}</span>}
      </div>
      <div
        className="mt-1.5 font-[family-name:var(--font-display)] text-[length:var(--text-2xl)] font-semibold tabular-nums leading-none"
        style={{ color: accent ?? 'var(--text)' }}
      >
        {value}
      </div>
      {hint && <p className="mt-1.5 text-[length:var(--text-2xs)] text-[var(--text-muted)] truncate">{hint}</p>}
    </div>
  )
}

export function StatRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-3 grid-cols-2 lg:grid-cols-4', className)}>{children}</div>
  )
}

/**
 * Empty states carry the next action. A first-run operator should never have to
 * guess what this screen is for.
 */
export function EmptyState({
  icon,
  title,
  description,
  steps,
  action
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  steps?: { title: string; body: string }[]
  action?: React.ReactNode
}) {
  return (
    <div className="max-w-2xl mx-auto my-8 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-sm)] p-6">
      <div className="flex items-center gap-3">
        {icon && (
          <span className="w-9 h-9 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] rounded-[var(--radius-sm)]">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="font-[family-name:var(--font-display)] text-[length:var(--text-base)] font-semibold text-[var(--text)]">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[length:var(--text-sm)] text-[var(--text-muted)]">{description}</p>}
        </div>
      </div>

      {steps && steps.length > 0 && (
        <ol className="mt-5 space-y-2.5">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className="w-5 h-5 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] text-[length:var(--text-2xs)] font-semibold tabular-nums text-[var(--text-secondary)]">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[length:var(--text-sm)] font-medium text-[var(--text)]">{s.title}</p>
                <p className="mt-0.5 text-[length:var(--text-xs)] text-[var(--text-muted)]">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/** Inline advisory. Not a toast — this one stays put while it is still true. */
export function Notice({
  tone = 'info',
  title,
  children
}: {
  tone?: Tone
  title?: string
  children: React.ReactNode
}) {
  const accent =
    tone === 'ok'
      ? 'var(--ok-strong)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'danger'
          ? 'var(--danger-strong)'
          : 'var(--text-muted)'
  return (
    <div
      className="px-3.5 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-sm)]"
      style={{ boxShadow: `inset 3px 0 0 0 ${accent}` }}
    >
      {title && (
        <p className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)]" style={{ color: accent }}>
          {title}
        </p>
      )}
      <div className="text-[length:var(--text-xs)] text-[var(--text-secondary)]">{children}</div>
    </div>
  )
}

export function LoadingScreen({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center h-full bg-[var(--bg-secondary)] gap-2 text-[var(--text-muted)]">
      <Loader2 className="w-5 h-5 animate-spin" />
      <span className="text-[length:var(--text-sm)]">{label}…</span>
    </div>
  )
}

/** Keyed detail list — label above value, wraps sensibly. */
export function DetailList({
  items,
  columns = 2
}: {
  items: [string, React.ReactNode][]
  columns?: 1 | 2 | 3
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-5 gap-y-3.5 grid-cols-1',
        columns === 2 && 'md:grid-cols-2',
        columns === 3 && 'md:grid-cols-3'
      )}
    >
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
            {label}
          </dt>
          <dd className="mt-0.5 text-[length:var(--text-sm)] text-[var(--text)] break-words">{value || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Segmented control for view/filter switching. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; count?: number; tone?: Tone }[]
  label: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex border border-[var(--border)] rounded-[var(--radius-sm)] overflow-hidden bg-[var(--bg-secondary)]"
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 h-7 text-[length:var(--text-xs)] font-medium transition-colors',
              'border-r border-[var(--border)] last:border-r-0',
              active
                ? 'bg-[var(--surface)] text-[var(--text)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]',
              focusRing
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <Badge tone={active ? (o.tone ?? 'info') : 'neutral'} className="px-1 py-0">
                {o.count}
              </Badge>
            )}
          </button>
        )
      })}
    </div>
  )
}
