'use client'

/**
 * Two-pane shell: conversation left, live document artifact right.
 *
 * The split is a percentage of the container, clamped so neither pane can be
 * squeezed below a usable width, and persisted to localStorage. Below the
 * `stackAt` breakpoint the panes stop coexisting and become one column with a
 * segmented switch — a 380px artifact rail beside a 380px chat is worse than
 * either one alone.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'

const STORAGE_KEY = 'ls_split_ratio'
const MIN_CHAT_PX = 420
const MIN_ARTIFACT_PX = 360
const DEFAULT_RATIO = 0.58
const STACK_AT = 1024

export type Pane = 'chat' | 'artifact'

interface SplitShellProps {
  chat: ReactNode
  artifact: ReactNode
  /** Rendered above the panes on narrow screens (mobile nav, etc.). */
  mobileHeader?: ReactNode
  /** Badge shown on the artifact tab in stacked mode — e.g. "7/12". */
  artifactBadge?: string | null
}

function clampRatio(ratio: number, width: number) {
  if (width <= 0) return ratio
  const min = MIN_CHAT_PX / width
  const max = (width - MIN_ARTIFACT_PX) / width
  if (min > max) return 0.5
  return Math.min(Math.max(ratio, min), max)
}

export default function SplitShell({
  chat,
  artifact,
  mobileHeader,
  artifactBadge
}: SplitShellProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(DEFAULT_RATIO)
  const [width, setWidth] = useState(0)
  const [stacked, setStacked] = useState(false)
  const [pane, setPane] = useState<Pane>('chat')
  const [dragging, setDragging] = useState(false)

  // Restore the remembered split before first paint so it doesn't jump.
  useLayoutEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      const n = saved ? Number.parseFloat(saved) : NaN
      if (Number.isFinite(n) && n > 0.15 && n < 0.85) setRatio(n)
    } catch {
      /* private mode / storage disabled — the default is fine */
    }
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      setWidth(w)
      setStacked(w < STACK_AT)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const commit = useCallback((next: number) => {
    setRatio(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next.toFixed(4))
    } catch {
      /* non-fatal */
    }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      setRatio(clampRatio((e.clientX - rect.left) / rect.width, rect.width))
    },
    [dragging]
  )

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      setDragging(false)
      commit(ratio)
    },
    [dragging, ratio, commit]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 0.08 : 0.02
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        commit(clampRatio(ratio - step, width))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        commit(clampRatio(ratio + step, width))
      } else if (e.key === 'Home') {
        e.preventDefault()
        commit(clampRatio(DEFAULT_RATIO, width))
      }
    },
    [ratio, width, commit]
  )

  const effective = clampRatio(ratio, width)

  if (stacked) {
    return (
      <div ref={containerRef} className="flex h-full min-w-0 flex-col">
        {mobileHeader}
        <div
          role="tablist"
          aria-label="View"
          className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5"
        >
          <PaneTab
            active={pane === 'chat'}
            onClick={() => setPane('chat')}
            label="Conversation"
          />
          <PaneTab
            active={pane === 'artifact'}
            onClick={() => setPane('artifact')}
            label="Document"
            badge={artifactBadge}
          />
        </div>
        <div className="relative min-h-0 flex-1">
          {/* Both panes stay mounted: switching tabs must not reset chat
              scroll position or tear down an in-flight stream. */}
          <div
            className={pane === 'chat' ? 'flex h-full flex-col bg-[var(--surface)]' : 'hidden'}
            role="tabpanel"
          >
            {chat}
          </div>
          <div
            className={pane === 'artifact' ? 'flex h-full flex-col bg-[var(--surface)]' : 'hidden'}
            role="tabpanel"
          >
            {artifact}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full min-w-0">
      <div
        className="flex min-w-0 flex-col bg-[var(--surface)]"
        style={{ width: `${effective * 100}%` }}
      >
        {chat}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize document panel"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(effective * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => commit(clampRatio(DEFAULT_RATIO, width))}
        onKeyDown={onKeyDown}
        className="group relative w-[8px] shrink-0 cursor-col-resize outline-none"
      >
        {/* Invisible until reached: the 8px band is the grab target; a thin
            blue bar reveals on hover, keyboard focus, or while dragging. */}
        <span
          aria-hidden
          className={`absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-blue-400 transition-opacity ${
            dragging
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          }`}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-[var(--surface)]">{artifact}</div>

      {/* While dragging, swallow pointer events over iframes/canvases so the
          drag doesn't die when the cursor crosses the PDF preview. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  )
}

function PaneTab({
  active,
  onClick,
  label,
  badge
}: {
  active: boolean
  onClick: () => void
  label: string
  badge?: string | null
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'bg-[var(--accent)] text-[var(--text)]'
          : 'text-[var(--faint,#9CA3AF)] hover:text-[var(--text-muted)]'
      }`}
    >
      {label}
      {badge && (
        <span className="text-[10px] tabular-nums text-[var(--text-muted)]">
          {badge}
        </span>
      )}
    </button>
  )
}
