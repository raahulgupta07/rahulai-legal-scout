import { useQueryState } from 'nuqs'
import { usePathname, useRouter } from 'next/navigation'
import { SessionEntry } from '@/types/os'
import useSessionLoader from '@/hooks/useSessionLoader'
import { deleteSessionAPI } from '@/api/os'
import { useStore } from '@/store'
import { toast } from 'sonner'
import { useState } from 'react'
import DeleteSessionModal from './DeleteSessionModal'
import useChatActions from '@/hooks/useChatActions'
import { cn } from '@/lib/utils'
import { Trash2 } from 'lucide-react'
import { focusRing } from '@/components/ui/kit'

/**
 * A session stamp reaches us in two shapes and only one of them is the one
 * `SessionEntry` declares: the type says `number` (unix seconds) but the live
 * API answers ISO-8601 UTC strings ("2026-08-24T13:40:50Z"). Accept both, and
 * return NaN — never a number — for anything unreadable, so every caller has
 * to decide what to do about it rather than silently rendering 1970.
 */
export function toMillis(
  timestamp: number | string | null | undefined
): number {
  if (timestamp === null || timestamp === undefined || timestamp === '') {
    return Number.NaN
  }
  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp) ? timestamp * 1000 : Number.NaN
  }
  return new Date(timestamp).getTime()
}

/**
 * Which stamp decides where a session sits in the list.
 *
 * `updated_at`, falling back to `created_at`. What the reader is looking for
 * is the conversation they last touched — a thread started last week and
 * replied to an hour ago belongs under Today, not under Previous 7 days.
 * `created_at` would file it by an event the reader has forgotten. The
 * fallback matters because `updated_at` is optional on `SessionEntry` and is
 * absent on a session that has never been reopened.
 */
export function sessionMillis(session: {
  created_at?: number | string | null
  updated_at?: number | string | null
}): number {
  const updated = toMillis(session?.updated_at)
  if (!Number.isNaN(updated)) return updated
  return toMillis(session?.created_at)
}

/**
 * Terse age, for the right-hand column: `now`, `12m`, `6h`, `4d`, `12w`.
 *
 * Deliberately not "ago"-suffixed prose — the column is scanned down, not
 * read, and every extra glyph competes with the session name for the width
 * this rail does not have. Returns '' for an unreadable stamp so the row
 * renders without a lying age.
 */
export function relativeAge(
  timestamp: number | string | null | undefined,
  now: number = Date.now()
): string {
  const t = toMillis(timestamp)
  if (Number.isNaN(t)) return ''
  // A stamp in the future is clock skew between server and browser, not a
  // scheduled chat. Clamp rather than render "-3h".
  const seconds = Math.max(0, Math.floor((now - t) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 13) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

/** The exact stamp, for the tooltip — "3d" is not enough to file by. */
export function exactTime(
  timestamp: number | string | null | undefined
): string | undefined {
  const t = toMillis(timestamp)
  return Number.isNaN(t) ? undefined : new Date(t).toLocaleString()
}

type SessionItemProps = SessionEntry & {
  isSelected: boolean
  currentSessionId: string | null
  onSessionClick: () => void
}
const SessionItem = ({
  session_name: title,
  session_id,
  created_at,
  updated_at,
  isSelected,
  currentSessionId,
  onSessionClick
}: SessionItemProps) => {
  const [urlAgentId] = useQueryState('agent')
  const [teamId] = useQueryState('team')
  const [urlDbId] = useQueryState('db_id')
  const [, setSessionId] = useQueryState('session')
  const pathname = usePathname()
  const router = useRouter()
  const authToken = useStore((state) => state.authToken)
  const { getSession } = useSessionLoader()
  const { selectedEndpoint, sessionsData, setSessionsData, mode, agents } =
    useStore()
  // Same fallback as Sessions.tsx: admin routes drop the query params.
  const agentId = urlAgentId ?? (teamId ? null : agents[0]?.id || null)
  const dbId = urlDbId ?? (teamId ? null : agents[0]?.db_id || null)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const { clearChat } = useChatActions()

  // A missing or whitespace-only name still has to produce a row a person can
  // aim at — never a zero-height button. No name is invented here: "Untitled
  // conversation" is a statement that the backend supplied nothing.
  const displayTitle = (typeof title === 'string' ? title.trim() : '')
    ? (title as string).trim()
    : 'Untitled conversation'
  const stamp = updated_at ?? created_at
  const age = relativeAge(stamp)
  const exact = exactTime(stamp)
  // Every session in this product is currently named after the same opening
  // line, so the age is the only thing distinguishing one row from the next.
  // It carries the full stamp in its own title for when "4d" is not enough.
  const rowTitle = age
    ? `${displayTitle} · ${age}${exact ? ` (${exact})` : ''}`
    : displayTitle

  const handleGetSession = async () => {
    if (!(agentId || teamId || dbId)) return

    onSessionClick()
    // The rail is global now: from an admin route the chat page isn't
    // mounted, so selecting a session must first navigate home with the
    // entity + session in the URL, then hydrate the store.
    if (pathname !== '/') {
      const params = new URLSearchParams()
      if (agentId) params.set('agent', agentId)
      if (teamId) params.set('team', teamId)
      if (dbId) params.set('db_id', dbId)
      params.set('session', session_id)
      router.push(`/?${params.toString()}`)
    }
    await getSession(
      {
        entityType: mode,
        agentId,
        teamId,
        dbId: dbId ?? ''
      },
      session_id
    )
    // On the chat page nuqs owns the param; after a cross-route push the
    // session is already in the URL and this would edit the wrong route.
    if (pathname === '/') setSessionId(session_id)
  }

  const handleDeleteSession = async () => {
    if (!(agentId || teamId || dbId)) return
    setIsDeleting(true)
    try {
      const response = await deleteSessionAPI(
        selectedEndpoint,
        dbId ?? '',
        session_id,
        authToken
      )

      if (response?.ok && sessionsData) {
        setSessionsData(sessionsData.filter((s) => s.session_id !== session_id))
        // If the deleted session was the active one, clear the chat
        if (currentSessionId === session_id) {
          setSessionId(null)
          clearChat()
        }
        toast.success('Session deleted')
      } else {
        const errorMsg = await response?.text()
        toast.error(
          `Failed to delete session: ${response?.statusText || 'Unknown error'} ${errorMsg || ''}`
        )
      }
    } catch (error) {
      toast.error(
        `Failed to delete session: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      setIsDeleteModalOpen(false)
      setIsDeleting(false)
    }
  }

  return (
    <>
      {/*
        A row, not a card. The current session is marked by an inset ink rule
        plus a raised ground — two cues, so it survives greyscale. The delete
        control is a real sibling button rather than an overlay, so it is
        reachable by keyboard even though it only becomes visible on hover.
      */}
      <div className="group relative flex w-full items-stretch">
        <button
          type="button"
          onClick={handleGetSession}
          aria-current={isSelected ? 'true' : undefined}
          title={rowTitle}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-8 text-left transition-colors',
            'rounded-[var(--radius-sm)]',
            focusRing,
            isSelected
              ? 'bg-[color-mix(in_srgb,var(--border)_70%,transparent)]'
              : 'hover:bg-[var(--accent)]'
          )}
        >
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] leading-5',
              isSelected
                ? 'font-medium text-[var(--text)]'
                : 'text-[var(--text-secondary)]'
            )}
          >
            {displayTitle}
          </span>
          {age && (
            /*
              The age sits where the delete control lands on hover, so it
              fades out to make room rather than being overdrawn. It is
              decoration for the pointer and duplicated in the row's title,
              so it is hidden from the accessibility tree.
            */
            <span
              aria-hidden
              className={cn(
                'shrink-0 text-[length:var(--text-2xs)] tabular-nums leading-5',
                'text-[var(--text-muted)] transition-opacity',
                'group-focus-within:opacity-0 group-hover:opacity-0'
              )}
            >
              {age}
            </span>
          )}
        </button>
        <button
          type="button"
          className={cn(
            'absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center',
            'rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-colors',
            'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
            'hover:bg-[color-mix(in_srgb,var(--danger-strong)_12%,transparent)] hover:text-[var(--danger-strong)]',
            focusRing
          )}
          onClick={(e) => {
            e.stopPropagation()
            setIsDeleteModalOpen(true)
          }}
          aria-label={`Delete conversation: ${displayTitle}`}
          title="Delete conversation"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <DeleteSessionModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onDelete={handleDeleteSession}
        isDeleting={isDeleting}
        sessionTitle={displayTitle}
      />
    </>
  )
}

export default SessionItem
