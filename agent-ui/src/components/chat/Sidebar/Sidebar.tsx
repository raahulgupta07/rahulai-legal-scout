'use client'
import { ModeSelector } from '@/components/chat/Sidebar/ModeSelector'
import { EntitySelector } from '@/components/chat/Sidebar/EntitySelector'
import useChatActions from '@/hooks/useChatActions'
import { useStore } from '@/store'
import { motion } from 'framer-motion'
import { useState, useEffect } from 'react'
import Sessions from './Sessions'
import AuthToken from './AuthToken'
import NewChatButton from './NewChatButton'
import { isValidUrl, cn, truncateText } from '@/lib/utils'
import { toast } from 'sonner'
import { useQueryState } from 'nuqs'
import { Skeleton } from '@/components/ui/skeleton'
import Link from 'next/link'
import {
  ChevronRight,
  LayoutGrid,
  LogOut,
  PanelLeft,
  Pencil,
  RefreshCw,
  Check,
  X
} from 'lucide-react'
import {
  Label,
  Badge,
  IconButton,
  Input,
  focusRing
} from '@/components/ui/kit'

const ENDPOINT_PLACEHOLDER = 'No endpoint set'

/**
 * Identity mark. A solid ink block with the initials is enough — a sidebar
 * this narrow cannot spare a row for decoration.
 */
const SidebarHeader = () => (
  <div className="flex items-center gap-2">
    <span
      aria-hidden
      className="grid h-6 w-6 shrink-0 place-items-center bg-[var(--surface-inverse)] text-[length:var(--text-2xs)] font-semibold text-[var(--text-inverse)]"
    >
      LS
    </span>
    <span className="truncate font-[family-name:var(--font-display)] text-[length:var(--text-sm)] font-semibold tracking-[-0.01em] text-[var(--text)]">
      Legal Scout
    </span>
  </div>
)

/** Read-only footnote under the entity picker; never a control. */
const ModelDisplay = ({ model }: { model: string }) => (
  <div className="flex items-baseline justify-between gap-2 px-0.5">
    <Label className="shrink-0">Model</Label>
    <span
      className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] text-[var(--text-muted)]"
      title={model}
    >
      {model}
    </span>
  </div>
)

const Endpoint = () => {
  const {
    selectedEndpoint,
    isEndpointActive,
    setSelectedEndpoint,
    setAgents,
    setSessionsData,
    setMessages
  } = useStore()
  const { initialize } = useChatActions()
  const [isEditing, setIsEditing] = useState(false)
  const [endpointValue, setEndpointValue] = useState('')
  const [isMounted, setIsMounted] = useState(false)
  const [isRotating, setIsRotating] = useState(false)
  const [, setAgentId] = useQueryState('agent')
  const [, setSessionId] = useQueryState('session')

  useEffect(() => {
    setEndpointValue(selectedEndpoint)
    setIsMounted(true)
  }, [selectedEndpoint])

  const handleSave = async () => {
    if (!isValidUrl(endpointValue)) {
      toast.error('Please enter a valid URL')
      return
    }
    const cleanEndpoint = endpointValue.replace(/\/$/, '').trim()
    setSelectedEndpoint(cleanEndpoint)
    setAgentId(null)
    setSessionId(null)
    setIsEditing(false)
    setAgents([])
    setSessionsData([])
    setMessages([])
  }

  const handleCancel = () => {
    setEndpointValue(selectedEndpoint)
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSave()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }

  const handleRefresh = async () => {
    setIsRotating(true)
    await initialize()
    setTimeout(() => setIsRotating(false), 500)
  }

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center justify-between gap-2">
        <Label>Endpoint</Label>
        {isMounted && (
          <Badge tone={isEndpointActive ? 'ok' : 'danger'} dot>
            {isEndpointActive ? 'Connected' : 'Offline'}
          </Badge>
        )}
      </div>

      {isEditing ? (
        <div className="flex items-center gap-1">
          <Input
            type="text"
            value={endpointValue}
            onChange={(e) => setEndpointValue(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Endpoint URL"
            autoFocus
            className="h-8 py-0 text-[length:var(--text-xs)]"
          />
          <IconButton
            aria-label="Save endpoint"
            title="Save endpoint"
            onClick={handleSave}
            icon={<Check className="h-3.5 w-3.5" />}
          />
          <IconButton
            aria-label="Cancel"
            title="Cancel"
            onClick={handleCancel}
            icon={<X className="h-3.5 w-3.5" />}
          />
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <p
            className="min-w-0 flex-1 truncate border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--text-secondary)] rounded-[var(--radius-sm)]"
            title={selectedEndpoint}
          >
            {isMounted
              ? truncateText(selectedEndpoint, 26) || ENDPOINT_PLACEHOLDER
              : 'Loading…'}
          </p>
          <IconButton
            aria-label="Edit endpoint"
            title="Edit endpoint"
            onClick={() => setIsEditing(true)}
            icon={<Pencil className="h-3 w-3" />}
          />
          <IconButton
            aria-label="Reconnect"
            title="Reconnect"
            onClick={handleRefresh}
            icon={
              <RefreshCw
                className={cn('h-3.5 w-3.5', isRotating && 'animate-spin')}
              />
            }
          />
        </div>
      )}
    </div>
  )
}

const Sidebar = ({
  hasEnvToken,
  envToken
}: {
  hasEnvToken?: boolean
  envToken?: string
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [showDevConfig, setShowDevConfig] = useState(false)
  const [userRole, setUserRole] = useState('user')
  const [user, setUser] = useState({ name: 'User', email: '' })

  useEffect(() => {
    try {
      const raw = localStorage.getItem('ls_user')
      if (!raw) return
      const parsed = JSON.parse(raw)
      setUserRole(parsed.role || 'user')
      setUser({
        name: parsed.name || parsed.email?.split('@')[0] || 'User',
        email: parsed.email || ''
      })
    } catch {}
  }, [])

  const { clearChat, focusChatInput, initialize } = useChatActions()
  const {
    selectedEndpoint,
    isEndpointActive,
    selectedModel,
    hydrated,
    isEndpointLoading,
    mode
  } = useStore()
  const [isMounted, setIsMounted] = useState(false)
  const [agentId] = useQueryState('agent')
  const [teamId] = useQueryState('team')

  useEffect(() => {
    setIsMounted(true)

    if (hydrated) initialize()
  }, [selectedEndpoint, initialize, hydrated, mode])

  const handleNewChat = () => {
    clearChat()
    focusChatInput()
  }

  const handleLogout = () => {
    localStorage.removeItem('ls_token')
    localStorage.removeItem('ls_user')
    window.location.href = '/login'
  }

  return (
    <motion.aside
      className="relative flex h-screen shrink-0 grow-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface)] px-2 py-3"
      initial={{ width: '16rem' }}
      animate={{ width: isCollapsed ? '2.75rem' : '16rem' }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className={cn(
          'absolute right-1.5 top-2.5 z-10 grid h-6 w-6 place-items-center',
          'rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-colors',
          'hover:bg-[var(--bg-secondary)] hover:text-[var(--text)]',
          focusRing
        )}
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!isCollapsed}
        type="button"
      >
        <PanelLeft className="h-4 w-4" aria-hidden />
      </button>

      <motion.div
        className="flex h-full w-60 min-h-0 flex-col overflow-hidden"
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: isCollapsed ? 0 : 1, x: isCollapsed ? -20 : 0 }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
        style={{ pointerEvents: isCollapsed ? 'none' : 'auto' }}
        aria-hidden={isCollapsed}
      >
        {/* Identity + the two things you can start from here. */}
        <div className="shrink-0 space-y-2.5 pr-7">
          <SidebarHeader />
        </div>
        <div className="mt-3 shrink-0 space-y-1.5">
          <NewChatButton onClick={handleNewChat} />
          <Link
            href="/admin/dashboard"
            className={cn(
              'flex w-full items-center gap-2 px-2.5 py-2 transition-colors',
              'rounded-[var(--radius-sm)] border border-[var(--border)]',
              'bg-[var(--bg-secondary)] text-[length:var(--text-sm)] text-[var(--text-secondary)]',
              'hover:bg-[var(--surface)] hover:text-[var(--text)]',
              focusRing
            )}
          >
            <LayoutGrid className="h-4 w-4 shrink-0" aria-hidden />
            Legal dashboard
          </Link>
        </div>

        {/* The list users come back to. Takes every pixel left over. */}
        <div className="mt-4 min-h-0 flex-1">
          {isMounted && isEndpointActive && <Sessions />}
        </div>

        {/* Who you are, and the way out. */}
        {isMounted && (
          <div className="mt-2 shrink-0 border-t border-[var(--border)] pt-2">
            <div className="flex items-center gap-2.5 px-1 py-1.5">
              <span
                aria-hidden
                className="grid h-7 w-7 shrink-0 place-items-center bg-[var(--surface-inverse)] text-[length:var(--text-2xs)] font-semibold text-[var(--text-inverse)]"
              >
                {user.name[0]?.toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-[length:var(--text-sm)] font-medium text-[var(--text)]"
                  title={user.email || user.name}
                >
                  {user.name}
                </p>
                <p className="truncate text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                  {userRole}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className={cn(
                'mt-0.5 flex w-full items-center gap-2 px-2.5 py-1.5 transition-colors',
                'rounded-[var(--radius-sm)] text-[length:var(--text-xs)] text-[var(--text-muted)]',
                'hover:bg-[color-mix(in_srgb,var(--danger-strong)_10%,transparent)] hover:text-[var(--danger-strong)]',
                focusRing
              )}
            >
              <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Sign out
            </button>
          </div>
        )}

        {/* Connection internals. Folded away — admins only, rarely touched. */}
        {isMounted && userRole === 'admin' && (
          <div className="shrink-0 border-t border-[var(--border)] pt-2">
            <button
              type="button"
              onClick={() => setShowDevConfig(!showDevConfig)}
              aria-expanded={showDevConfig}
              className={cn(
                'flex w-full items-center gap-1.5 px-2 py-1.5 transition-colors',
                'rounded-[var(--radius-sm)] text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)]',
                'text-[var(--text-muted)] hover:text-[var(--text)]',
                focusRing
              )}
            >
              <ChevronRight
                className={cn(
                  'h-3 w-3 transition-transform',
                  showDevConfig && 'rotate-90'
                )}
                aria-hidden
              />
              Connection
            </button>
            {showDevConfig && (
              <div className="mt-2 max-h-[40vh] space-y-3 overflow-y-auto px-1 pb-2">
                <Endpoint />
                <AuthToken hasEnvToken={hasEnvToken} envToken={envToken} />
                {isEndpointActive &&
                  (isEndpointLoading ? (
                    <div className="flex w-full flex-col gap-2">
                      {Array.from({ length: 3 }).map((_, index) => (
                        <Skeleton
                          key={index}
                          className="h-9 w-full rounded-[var(--radius-sm)] bg-[var(--bg-secondary)]"
                        />
                      ))}
                    </div>
                  ) : (
                    <>
                      <ModeSelector />
                      <EntitySelector />
                      {selectedModel && (agentId || teamId) && (
                        <ModelDisplay model={selectedModel} />
                      )}
                    </>
                  ))}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </motion.aside>
  )
}

export default Sidebar
