'use client'

import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { useQueryState } from 'nuqs'

type QuickAction = {
  label: string
  prompt: string
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'Create AGM minutes', prompt: 'Create AGM for City Holdings Limited' },
  { label: 'Create a director consent form', prompt: 'Create Director Consent Form' },
  { label: 'List all companies', prompt: 'List all companies' },
  { label: 'Show all templates', prompt: 'Show all templates' }
]

function timeGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** First name from the persisted login record, if any. */
function readFirstName(): string {
  if (typeof window === 'undefined') return ''
  try {
    const raw = localStorage.getItem('ls_user')
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    const name: string = parsed?.name || parsed?.email?.split('@')[0] || ''
    return String(name).trim().split(/\s+/)[0] || ''
  } catch {
    return ''
  }
}

const ChatBlankState = () => {
  const { setPendingMessage } = useStore()
  const [agentId, setAgentId] = useQueryState('agent')
  const [, setDbId] = useQueryState('db_id')

  // Resolved on the client only: the greeting and name depend on the local
  // clock and localStorage, neither of which exists at render on the server.
  const [salutation, setSalutation] = useState('')
  const [firstName, setFirstName] = useState('')

  useEffect(() => {
    setSalutation(timeGreeting())
    setFirstName(readFirstName())
  }, [])

  const handleQuickAction = (prompt: string) => {
    if (!agentId) {
      setAgentId('scout')
      setDbId('scout-db')
      setTimeout(() => setPendingMessage(prompt), 300)
    } else {
      setPendingMessage(prompt)
    }
  }

  const greeting = salutation
    ? `${salutation}${firstName ? `, ${firstName}` : ''}! What can I help with?`
    : 'What can I help with?'

  return (
    <section
      aria-label="Getting started"
      className="relative isolate flex w-full flex-col items-center px-4 py-10 text-center font-[family-name:var(--font-body)]"
    >
      {/* Faint 24px grid, fading out toward the top — decorative, never
          interactive. color-mix keeps the line legible in both themes. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage:
            'linear-gradient(to right, color-mix(in srgb, var(--text) 4%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--text) 4%, transparent) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          maskImage: 'linear-gradient(to bottom, transparent, black)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent, black)'
        }}
      />

      {/* Blurred pastel glow anchored to the bottom of the viewport. */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-1/2 z-0 -translate-x-1/2"
        style={{
          width: 160,
          height: 160,
          bottom: -180,
          borderRadius: 9999,
          background: 'linear-gradient(45deg, #BE93C5, #7BC6CC, #DBE6F6)',
          filter: 'blur(60px)'
        }}
      />

      <div className="relative z-10 flex w-full max-w-2xl flex-col items-center">
        {/* LS mark — the one ink block on the home screen. */}
        <div
          aria-hidden
          className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--surface-inverse)]"
        >
          <span className="font-[family-name:var(--font-display)] text-[length:var(--text-base)] font-bold tracking-[var(--tracking-tag)] text-[var(--text-inverse)]">
            LS
          </span>
        </div>

        <h1 className="mt-6 text-3xl font-normal tracking-[-0.01em] text-[var(--text)]">
          {greeting}
        </h1>

        <p className="mt-2 max-w-prose text-[length:var(--text-sm)] leading-relaxed text-[var(--text-muted)]">
          Describe the document you need and Scout matches it to a trained
          template, pulls the company&apos;s registered details, and returns a
          filled <code className="font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--text-secondary)]">.docx</code>.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.prompt}
              type="button"
              onClick={() => handleQuickAction(action.prompt)}
              className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)]
                         px-4 py-2 text-xs font-medium text-[var(--text-secondary)]
                         transition-colors duration-150 motion-reduce:transition-none
                         hover:border-[var(--border-strong)]
                         hover:bg-gradient-to-b hover:from-[var(--surface)] hover:to-[var(--bg-secondary)]
                         hover:text-[var(--text)]
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

export default ChatBlankState
