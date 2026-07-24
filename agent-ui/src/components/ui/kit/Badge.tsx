'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * State is encoded in form as well as colour: each tone carries a distinct dot
 * and border weight, so the meaning survives greyscale and colour-blindness.
 * Semantic tones (ok/warn/danger) are deliberately separate from the accent —
 * an accent badge means "selected", never "healthy".
 */
export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'

const TONES: Record<Tone, { soft: string; solid: string; dot: string }> = {
  neutral: {
    soft: 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--border)]',
    solid: 'bg-[var(--surface-inverse)] text-[var(--text-inverse)] border-[var(--surface-inverse)]',
    dot: 'bg-[var(--text-muted)]'
  },
  ok: {
    soft: 'bg-[color-mix(in_srgb,var(--ok-strong)_12%,transparent)] text-[var(--ok-strong)] border-[color-mix(in_srgb,var(--ok-strong)_38%,transparent)]',
    solid: 'bg-[var(--ok-strong)] text-[var(--brand-fg)] border-[var(--ok-strong)]',
    dot: 'bg-[var(--ok-strong)]'
  },
  warn: {
    soft: 'bg-[color-mix(in_srgb,var(--warn)_16%,transparent)] text-[color-mix(in_srgb,var(--warn)_72%,var(--ink))] border-[color-mix(in_srgb,var(--warn)_42%,transparent)]',
    solid: 'bg-[var(--warn)] text-[var(--ink)] border-[var(--warn)]',
    dot: 'bg-[var(--warn)]'
  },
  danger: {
    soft: 'bg-[color-mix(in_srgb,var(--danger-strong)_12%,transparent)] text-[var(--danger-strong)] border-[color-mix(in_srgb,var(--danger-strong)_38%,transparent)]',
    solid: 'bg-[var(--danger-strong)] text-[var(--brand-fg)] border-[var(--danger-strong)]',
    dot: 'bg-[var(--danger-strong)]'
  },
  info: {
    soft: 'bg-[color-mix(in_srgb,var(--ink)_7%,transparent)] text-[var(--text-secondary)] border-[var(--border)]',
    solid: 'bg-[var(--ink)] text-[var(--text-inverse)] border-[var(--ink)]',
    dot: 'bg-[var(--ink)]'
  },
  accent: {
    soft: 'bg-[color-mix(in_srgb,var(--brand)_12%,transparent)] text-[var(--brand)] border-[color-mix(in_srgb,var(--brand)_40%,transparent)]',
    solid: 'bg-[var(--brand)] text-[var(--brand-fg)] border-[var(--brand)]',
    dot: 'bg-[var(--brand)]'
  }
}

export function Badge({
  tone = 'neutral',
  solid = false,
  dot = false,
  className,
  children,
  ...props
}: {
  tone?: Tone
  solid?: boolean
  dot?: boolean
  children: React.ReactNode
} & React.HTMLAttributes<HTMLSpanElement>) {
  const t = TONES[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 border px-2 py-0.5 rounded-[var(--radius-full)]',
        'text-[length:var(--text-2xs)] font-medium leading-4 whitespace-nowrap',
        solid ? t.solid : t.soft,
        className
      )}
      {...props}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-[999px]', solid ? 'bg-current' : t.dot)} aria-hidden />}
      {children}
    </span>
  )
}

/**
 * Micro caption above a value, or a table column heading. Uppercase and tracked
 * so it reads as a label rather than as content.
 */
export function Label({ className, children, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'block text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]',
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}

/**
 * A 4px severity stripe for the leading cell of a row or the edge of a card.
 * Lets a list communicate "these need attention" before any text is read.
 */
export function SeverityStripe({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      className={cn('absolute left-0 top-0 bottom-0 w-[3px]', TONES[tone].dot)}
    />
  )
}
