import { useQueryState } from 'nuqs'
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

function toMillis(timestamp: number | string): number {
  return typeof timestamp === 'number'
    ? timestamp * 1000
    : new Date(timestamp).getTime()
}

/** Coarse and short — the list is scanned, not read. */
function timeAgo(timestamp: number | string | undefined): string {
  if (!timestamp) return ''
  const t = toMillis(timestamp)
  if (Number.isNaN(t)) return ''
  const minutes = Math.floor((Date.now() - t) / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  })
}

/** The exact stamp, for the tooltip — "3d ago" is not enough to file by. */
function exactTime(timestamp: number | string | undefined): string | undefined {
  if (!timestamp) return undefined
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
  isSelected,
  currentSessionId,
  onSessionClick
}: SessionItemProps) => {
  const [agentId] = useQueryState('agent')
  const [teamId] = useQueryState('team')
  const [dbId] = useQueryState('db_id')
  const [, setSessionId] = useQueryState('session')
  const authToken = useStore((state) => state.authToken)
  const { getSession } = useSessionLoader()
  const { selectedEndpoint, sessionsData, setSessionsData, mode } = useStore()
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const { clearChat } = useChatActions()

  const displayTitle = title || 'Untitled conversation'

  const handleGetSession = async () => {
    if (!(agentId || teamId || dbId)) return

    onSessionClick()
    await getSession(
      {
        entityType: mode,
        agentId,
        teamId,
        dbId: dbId ?? ''
      },
      session_id
    )
    setSessionId(session_id)
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
          title={displayTitle}
          className={cn(
            'flex min-w-0 flex-1 items-center py-1.5 pl-2.5 pr-8 text-left transition-colors',
            'rounded-[var(--radius-sm)]',
            focusRing,
            isSelected
              ? 'bg-[color-mix(in_srgb,var(--border)_70%,transparent)]'
              : 'hover:bg-[var(--accent)]'
          )}
        >
          <span
            className={cn(
              'w-full truncate text-[13px] leading-5',
              isSelected
                ? 'font-medium text-[var(--text)]'
                : 'text-[var(--text-secondary)]'
            )}
            title={
              created_at
                ? `${displayTitle} · ${timeAgo(created_at)} (${exactTime(created_at) ?? ''})`
                : displayTitle
            }
          >
            {displayTitle}
          </span>
        </button>
        <button
          type="button"
          className={cn(
            'absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center',
            'rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-colors',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
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
