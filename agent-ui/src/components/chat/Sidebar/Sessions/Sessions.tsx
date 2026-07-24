'use client'

import { FC, useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryState } from 'nuqs'

import { useStore } from '@/store'
import useSessionLoader from '@/hooks/useSessionLoader'

import SessionItem from './SessionItem'
import SessionBlankState from './SessionBlankState'
import { Skeleton } from '@/components/ui/skeleton'

interface SkeletonListProps {
  skeletonCount: number
}
const SkeletonList: FC<SkeletonListProps> = ({ skeletonCount }) => {
  const list = useMemo(
    () => Array.from({ length: skeletonCount }, (_, i) => i),
    [skeletonCount]
  )

  // Rows fade out down the list so the placeholder reads as "loading", not as
  // content. The radius comes from the --radius-sm token so it tracks the
  // token layer rather than Tailwind's own scale.
  return list.map((k, idx) => (
    <Skeleton
      key={k}
      className="mb-1 h-11 rounded-[var(--radius-sm)] bg-[var(--bg-secondary)]"
      style={{ opacity: 1 - idx * 0.15 }}
    />
  ))
}

/** The scrolling list, no caption — the rail already reads as history here. */
const SessionsShell = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full min-h-0 w-full flex-col">{children}</div>
)

const Sessions = () => {
  const [urlAgentId] = useQueryState('agent', {
    parse: (v: string | null) => v || undefined,
    history: 'push'
  })
  const [teamId] = useQueryState('team')
  const [sessionId] = useQueryState('session')
  const [urlDbId] = useQueryState('db_id')

  const {
    selectedEndpoint,
    mode,
    isEndpointActive,
    isEndpointLoading,
    hydrated,
    sessionsData,
    setSessionsData,
    isSessionsLoading,
    agents
  } = useStore()

  // The rail is global: admin routes carry no ?agent/?db_id params, so fall
  // back to the first loaded agent (single-agent product) to keep history
  // alive everywhere.
  const agentId = urlAgentId ?? (teamId ? null : (agents[0]?.id ?? null))
  const dbId = urlDbId ?? (teamId ? null : (agents[0]?.db_id ?? null))

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  )

  const { getSessions, getSession } = useSessionLoader()

  useEffect(() => {
    if (hydrated && sessionId && selectedEndpoint && (agentId || teamId)) {
      const entityType = agentId ? 'agent' : 'team'
      getSession({ entityType, agentId, teamId, dbId }, sessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, sessionId, selectedEndpoint, agentId, teamId, dbId])

  useEffect(() => {
    if (!selectedEndpoint || isEndpointLoading) return
    if (!(agentId || teamId || dbId)) {
      setSessionsData([])
      return
    }
    setSessionsData([])
    getSessions({
      entityType: mode,
      agentId,
      teamId,
      dbId
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedEndpoint,
    agentId,
    teamId,
    mode,
    isEndpointLoading,
    getSessions,
    dbId
  ])

  useEffect(() => {
    if (sessionId) setSelectedSessionId(sessionId)
  }, [sessionId])

  const handleSessionClick = useCallback(
    (id: string) => () => setSelectedSessionId(id),
    []
  )

  if (isSessionsLoading || isEndpointLoading) {
    return (
      <SessionsShell>
        <div className="min-h-0 flex-1 overflow-hidden" aria-busy>
          <SkeletonList skeletonCount={5} />
        </div>
      </SessionsShell>
    )
  }

  const isEmpty =
    !isEndpointActive || !sessionsData || sessionsData.length === 0

  return (
    <SessionsShell>
      {/*
        The list owns its own scroll and is sized by the flex parent. The old
        h-[calc(100vh-345px)] guessed at the height of everything above it and
        broke whenever a band was added.
      */}
      <nav
        aria-label="Conversation history"
        className="min-h-0 flex-1 overflow-y-auto pr-0.5 [&::-webkit-scrollbar-thumb]:bg-[var(--border)] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1"
      >
        {isEmpty ? (
          <SessionBlankState />
        ) : (
          <div className="flex flex-col gap-y-0.5">
            {sessionsData?.map((entry, idx) => (
              <SessionItem
                key={`${entry?.session_id}-${idx}`}
                currentSessionId={selectedSessionId}
                isSelected={selectedSessionId === entry?.session_id}
                onSessionClick={handleSessionClick(entry?.session_id)}
                session_name={entry?.session_name ?? '-'}
                session_id={entry?.session_id}
                created_at={entry?.created_at}
              />
            ))}
          </div>
        )}
      </nav>
    </SessionsShell>
  )
}

export default Sessions
