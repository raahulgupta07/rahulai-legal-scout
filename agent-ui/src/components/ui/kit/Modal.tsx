'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton } from './Button'

/**
 * Focus trap, escape-to-close and scroll lock come from Radix; the chrome is
 * ours. Header and footer are fixed, the body scrolls — a long form must never
 * push its own save button off-screen.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  footer,
  size = 'md',
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  children: React.ReactNode
}) {
  const width = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl'
  }[size]

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[color-mix(in_srgb,var(--surface-inverse)_55%,transparent)] backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'flex flex-col max-h-[85vh]',
            'bg-[var(--surface)] border border-[var(--border-strong)] rounded-[var(--radius-sm)]',
            'shadow-[0_16px_48px_-12px_rgba(0,0,0,0.35)]',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            width
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 py-3.5 border-b border-[var(--border)]">
            <div className="min-w-0">
              <Dialog.Title className="font-[family-name:var(--font-display)] text-[length:var(--text-base)] font-semibold text-[var(--text)] truncate">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                  {description}
                </Dialog.Description>
              ) : (
                // Radix warns when Content has no description; an explicit
                // empty one keeps the console clean without inventing copy.
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton aria-label="Close" icon={<X className="w-4 h-4" />} />
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer && (
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
