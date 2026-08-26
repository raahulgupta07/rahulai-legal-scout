'use client'

import * as React from 'react'
import { useCanWrite } from '@/app/admin/roleClient'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Every colour resolves through a token. Radius comes from --radius-sm so the
 * whole app changes shape from one place.
 *
 * Note on `rounded-[var(--radius-sm)]` rather than `rounded-md`: the radius
 * comes from the --radius-sm token so it tracks the token layer rather than
 * Tailwind's own scale.
 */
export const focusRing =
  'focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
export type ButtonSize = 'sm' | 'md' | 'icon'

const VARIANTS: Record<ButtonVariant, string> = {
  // The one accented action per view.
  primary:
    'bg-[var(--brand)] text-[var(--brand-fg)] border border-[var(--brand)] hover:bg-[color-mix(in_srgb,var(--brand)_86%,black)]',
  // The default for everything else: reads as a control, not as decoration.
  secondary:
    'bg-[var(--surface)] text-[var(--text)] border border-[var(--border-strong)] hover:bg-[var(--bg-secondary)]',
  subtle:
    'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface)]',
  ghost:
    'bg-transparent text-[var(--text-secondary)] border border-transparent hover:bg-[var(--accent)] hover:text-[var(--text)]',
  danger:
    'bg-[var(--danger-strong)] text-[var(--brand-fg)] border border-[var(--danger-strong)] hover:bg-[color-mix(in_srgb,var(--danger-strong)_85%,black)]'
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[length:var(--text-xs)] gap-1.5',
  md: 'h-9 px-3.5 text-[length:var(--text-sm)] gap-2',
  icon: 'h-8 w-8 justify-center'
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and blocks interaction. Keeps the label so width is stable. */
  loading?: boolean
  icon?: React.ReactNode
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, className, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center whitespace-nowrap font-medium rounded-[var(--radius-sm)]',
        'transition-colors disabled:opacity-45 disabled:cursor-not-allowed',
        '[&_svg]:shrink-0',
        VARIANTS[variant],
        SIZES[size],
        focusRing,
        className
      )}
      {...props}
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
      ) : (
        icon
      )}
      {children}
    </button>
  )
})

/** Small square action used inside table rows. Always give it an aria-label. */
export const IconButton = React.forwardRef<HTMLButtonElement, ButtonProps>(function IconButton(
  { className, ...props },
  ref
) {
  return <Button ref={ref} size="icon" variant="ghost" className={cn('p-0', className)} {...props} />
})

/**
 * Two-step destructive action: arm, then confirm. Nothing irreversible is ever
 * one click away, and the armed state is visually loud so it cannot be missed.
 *
 * ★ Renders NOTHING for an account that may not change shared records. Every
 * use of this component is destructive — delete a template, a company, a
 * person, a skill, a document, a user — so the rule can live here once instead
 * of being remembered at eighteen call sites, which is how one gets missed.
 *
 * This hides the control. It does not enforce anything: `require_write` on the
 * server refuses the request whatever the browser drew. Never read an absent
 * button as a permission boundary.
 */
export function ConfirmButton({
  onConfirm,
  label,
  compact = false,
  icon,
  confirmLabel = 'Confirm',
  children
}: {
  onConfirm: () => void
  label: string
  compact?: boolean
  icon?: React.ReactNode
  confirmLabel?: string
  children?: React.ReactNode
}) {
  const [armed, setArmed] = React.useState(false)
  const mayWrite = useCanWrite()

  React.useEffect(() => {
    if (!armed) return
    // Disarm on its own so a half-pressed delete never sits there waiting.
    const t = setTimeout(() => setArmed(false), 5000)
    return () => clearTimeout(t)
  }, [armed])

  if (!mayWrite) return null

  if (!armed) {
    return compact ? (
      <IconButton
        aria-label={label}
        title={label}
        onClick={() => setArmed(true)}
        className="hover:text-[var(--danger-strong)]"
        icon={icon}
      />
    ) : (
      <Button variant="ghost" onClick={() => setArmed(true)} icon={icon} className="text-[var(--danger-strong)]">
        {children ?? label}
      </Button>
    )
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant="danger" autoFocus onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </span>
  )
}
