'use client'

import type React from 'react'

import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { ArrowDown } from 'lucide-react'

const ScrollToBottom: React.FC = () => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  const reduceMotion = useReducedMotion()

  return (
    <AnimatePresence>
      {!isAtBottom && (
        <motion.div
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
          transition={{ duration: reduceMotion ? 0.12 : 0.25, ease: 'easeOut' }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2"
        >
          {/*
            rounded-[999px] rather than rounded-full: a pill radius that stays
            circular regardless of the Tailwind rounding scale.
          */}
          <button
            type="button"
            onClick={() => scrollToBottom()}
            aria-label="Scroll to latest message"
            title="Scroll to latest message"
            className="inline-flex items-center gap-1.5 rounded-[999px]
                       border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-3 pr-3.5
                       font-[family-name:var(--font-body)] text-[length:var(--text-xs)] text-[var(--text-secondary)]
                       shadow-md transition-colors duration-150 motion-reduce:transition-none
                       hover:bg-[var(--accent)] hover:text-[var(--text)]
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]
                       focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            Latest
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default ScrollToBottom
