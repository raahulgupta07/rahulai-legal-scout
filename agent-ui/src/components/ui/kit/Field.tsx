'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { focusRing } from './Button'

/** Shared control chrome. One definition, so every input in the app matches. */
export const controlBase = cn(
  'w-full bg-[var(--surface)] text-[var(--text)] border border-[var(--border)]',
  'rounded-[var(--radius-md)] px-2.5 py-1.5 text-[length:var(--text-sm)]',
  'placeholder:text-[var(--text-muted)] transition-colors',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  focusRing
)

const invalidRing = 'border-[var(--danger-strong)] focus-visible:ring-[var(--danger-strong)]'

/**
 * Label + control + hint/error, in one predictable block.
 *
 * Pass any control as children; Field supplies the id wiring so the label and
 * the description are actually associated for screen readers.
 */
export function Field({
  label,
  hint,
  error,
  required,
  wide,
  htmlFor,
  className,
  children
}: {
  label: string
  hint?: string
  error?: string
  required?: boolean
  /** Spans both columns of a 2-col form grid. */
  wide?: boolean
  htmlFor?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn(wide && 'md:col-span-2', className)}>
      <label
        htmlFor={htmlFor}
        className="block mb-1 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]"
      >
        {label}
        {required && <span className="ml-1 text-[var(--danger-strong)]">*</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-[length:var(--text-2xs)] text-[var(--danger-strong)]">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[length:var(--text-2xs)] text-[var(--text-muted)]">{hint}</p>
      ) : null}
    </div>
  )
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className, invalid, ...props }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(controlBase, invalid && invalidRing, className)}
      {...props}
    />
  )
})

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(controlBase, 'resize-y min-h-[76px]', invalid && invalidRing, className)}
      {...props}
    />
  )
})

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & {
    options: { value: string; label: string }[]
    invalid?: boolean
  }
>(function Select({ className, options, invalid, ...props }, ref) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(controlBase, 'appearance-none pr-8', invalid && invalidRing, className)}
      {...props}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
})

/** Convenience wrappers for the overwhelmingly common label+input pairing. */
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  wide,
  type = 'text',
  placeholder,
  mono,
  ...rest
}: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string
  error?: string
  required?: boolean
  wide?: boolean
  type?: string
  placeholder?: string
  /** Use for identifiers and codes — aligns characters, kills ambiguity. */
  mono?: boolean
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const id = React.useId()
  return (
    <Field label={label} hint={hint} error={error} required={required} wide={wide} htmlFor={id}>
      <Input
        id={id}
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
        className={mono ? 'font-mono tabular-nums' : undefined}
        {...rest}
      />
    </Field>
  )
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  required,
  wide
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  hint?: string
  error?: string
  required?: boolean
  wide?: boolean
}) {
  const id = React.useId()
  return (
    <Field label={label} hint={hint} error={error} required={required} wide={wide} htmlFor={id}>
      <Select id={id} value={value ?? ''} options={options} invalid={!!error} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

export function TextareaField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  wide,
  rows = 4,
  placeholder
}: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string
  error?: string
  required?: boolean
  wide?: boolean
  rows?: number
  placeholder?: string
}) {
  const id = React.useId()
  return (
    <Field label={label} hint={hint} error={error} required={required} wide={wide} htmlFor={id}>
      <Textarea
        id={id}
        rows={rows}
        value={value ?? ''}
        placeholder={placeholder}
        invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 cursor-pointer select-none',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={cn('mt-0.5 w-4 h-4 accent-[var(--brand)] shrink-0', focusRing)}
      />
      <span className="min-w-0">
        <span className="block text-[length:var(--text-sm)] text-[var(--text)]">{label}</span>
        {hint && <span className="block text-[length:var(--text-2xs)] text-[var(--text-muted)]">{hint}</span>}
      </span>
    </label>
  )
}

/** Standard 2-column form grid. */
export function FormGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5', className)}>{children}</div>
}
