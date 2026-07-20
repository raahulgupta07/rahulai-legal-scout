'use client'

import { motion, useReducedMotion } from 'framer-motion'
import { FileText, List } from 'lucide-react'
import { useStore } from '@/store'
import { useQueryState } from 'nuqs'

type QuickAction = {
  title: string
  hint: string
  prompt: string
  kind: 'generate' | 'browse'
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    title: 'Create AGM minutes',
    hint: 'Annual general meeting record for a registered company',
    prompt: 'Create AGM for City Holdings Limited',
    kind: 'generate'
  },
  {
    title: 'Create a director consent form',
    hint: 'Consent to act as director, ready for signature',
    prompt: 'Create Director Consent Form',
    kind: 'generate'
  },
  {
    title: 'List all companies',
    hint: 'See which companies Scout already holds data for',
    prompt: 'List all companies',
    kind: 'browse'
  },
  {
    title: 'Show all templates',
    hint: 'Browse the trained document templates',
    prompt: 'Show all templates',
    kind: 'browse'
  }
]

const ChatBlankState = () => {
  const { setPendingMessage } = useStore()
  const [agentId, setAgentId] = useQueryState('agent')
  const [, setDbId] = useQueryState('db_id')
  const reduceMotion = useReducedMotion()

  const handleQuickAction = (prompt: string) => {
    if (!agentId) {
      setAgentId('scout')
      setDbId('scout-db')
      setTimeout(() => setPendingMessage(prompt), 300)
    } else {
      setPendingMessage(prompt)
    }
  }

  // Framer's useReducedMotion collapses the entrance offsets rather than
  // removing the component's structure.
  const rise = (delay: number) => ({
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reduceMotion ? 0.15 : 0.35, delay: reduceMotion ? 0 : delay }
  })

  return (
    <section
      className="mx-auto w-full max-w-2xl font-[family-name:var(--font-body)]"
      aria-label="Getting started"
    >
      <motion.div {...rise(0)} className="flex flex-col gap-2">
        <p className="font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] uppercase tracking-[0.14em] text-[var(--text-muted)]">
          Myanmar corporate law
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-[length:var(--text-2xl)] font-semibold tracking-[-0.01em] text-[var(--text)]">
          Legal Scout
        </h1>
        <p className="max-w-prose text-[length:var(--text-sm)] leading-relaxed text-[var(--text-muted)]">
          Describe the document you need. Scout matches it to a trained template, pulls the
          company&apos;s registered details, and returns a filled <code className="font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--text-secondary)]">.docx</code> you
          can download. It will ask for anything it cannot find on file.
        </p>
      </motion.div>

      <motion.div {...rise(0.1)} className="mt-7">
        <h2 className="mb-2 font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] uppercase tracking-[0.14em] text-[var(--text-muted)]">
          Start with
        </h2>

        <ul className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
          {QUICK_ACTIONS.map((action) => {
            const ActionIcon = action.kind === 'generate' ? FileText : List
            return (
              <li key={action.prompt}>
                <button
                  type="button"
                  onClick={() => handleQuickAction(action.prompt)}
                  className="group flex w-full items-start gap-3 px-1 py-3 text-left
                             transition-colors duration-150 motion-reduce:transition-none
                             hover:bg-[var(--accent)]
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                >
                  <ActionIcon
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-[var(--brand)] motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[length:var(--text-sm)] font-medium text-[var(--text)]">
                      {action.title}
                    </span>
                    <span className="text-[length:var(--text-xs)] leading-normal text-[var(--text-muted)]">
                      {action.hint}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </motion.div>
    </section>
  )
}

export default ChatBlankState
