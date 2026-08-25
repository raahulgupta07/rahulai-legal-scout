'use client'

import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryState } from 'nuqs'
import { RotateCw, WifiOff } from 'lucide-react'

import { useStore } from '@/store'
import useSessionLoader from '@/hooks/useSessionLoader'
import { SessionEntry } from '@/types/os'
import { cn } from '@/lib/utils'
import { focusRing } from '@/components/ui/kit'

import SessionItem, { sessionMillis } from './SessionItem'
import SessionBlankState from './SessionBlankState'
import { Skeleton } from '@/components/ui/skeleton'

/* ------------------------------------------------------------------ *
 * Date bucketing
 *
 * Pure, exported, and deliberately free of React so the boundaries can
 * be exercised without a renderer.
 * ------------------------------------------------------------------ */

export type BucketId = 'today' | 'week' | 'month' | 'older' | 'undated'

const BUCKET_ORDER: BucketId[] = ['today', 'week', 'month', 'older', 'undated']

const BUCKET_LABEL: Record<BucketId, string> = {
  today: 'Today',
  week: 'Previous 7 days',
  month: 'Previous 30 days',
  older: 'Older',
  // A row with no readable stamp still has to appear somewhere. Dropping it
  // would hide a real conversation; filing it under "Older" would be a claim
  // about a date we do not have.
  undated: 'Undated'
}

/** Midnight at the START of the day `daysAgo` days back, in the VIEWER's zone. */
function localDayStart(now: number, daysAgo: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  // Stepping the date component (rather than subtracting 86_400_000 ms) keeps
  // the boundary on real local midnight across a DST change.
  if (daysAgo) d.setDate(d.getDate() - daysAgo)
  return d.getTime()
}

/**
 * Which heading a session sits under.
 *
 * ★ The stamps arrive as UTC ("...Z"), but "Today" is a claim about the
 * READER's calendar, not the server's. `Date#setHours` operates in the
 * browser's local zone, so the boundary is local midnight — which for this
 * user (Myanmar, UTC+06:30) is 17:30Z the previous day. Comparing against a
 * UTC midnight would file 06:30 local yesterday's chats under Today and this
 * morning's under Previous 7 days, for six and a half hours every day.
 *
 * Boundaries are half-open and chained (`>= today`, else `>= today-7`, …), so
 * no session can match two buckets and none can match none.
 */
export function bucketFor(millis: number, now: number = Date.now()): BucketId {
  if (!Number.isFinite(millis)) return 'undated'
  // A future stamp is clock skew, not a scheduled chat — it belongs at the top.
  if (millis >= localDayStart(now, 0)) return 'today'
  if (millis >= localDayStart(now, 7)) return 'week'
  if (millis >= localDayStart(now, 30)) return 'month'
  return 'older'
}

export interface SessionGroup {
  id: BucketId
  label: string
  sessions: SessionEntry[]
}

/**
 * Split into ordered, non-overlapping groups, newest first within each.
 *
 * Every input row comes out in exactly one group; empty groups are omitted
 * rather than rendered as a bare heading.
 */
export function groupSessions(
  sessions: SessionEntry[] | null | undefined,
  now: number = Date.now()
): SessionGroup[] {
  if (!sessions?.length) return []

  const buckets = new Map<BucketId, { entry: SessionEntry; at: number }[]>()
  sessions.forEach((entry) => {
    const at = sessionMillis(entry ?? {})
    const id = bucketFor(at, now)
    const list = buckets.get(id) ?? []
    list.push({ entry, at })
    buckets.set(id, list)
  })

  return BUCKET_ORDER.flatMap((id) => {
    const list = buckets.get(id)
    if (!list?.length) return []
    // Undated rows have nothing to sort by — keep the server's order rather
    // than shuffling them by a NaN comparison.
    if (id !== 'undated') list.sort((a, b) => b.at - a.at)
    return [
      { id, label: BUCKET_LABEL[id], sessions: list.map((row) => row.entry) }
    ]
  })
}

/* ------------------------------------------------------------------ *
 * The error channel
 * ------------------------------------------------------------------ */

/**
 * Read a load failure off the store WITHOUT depending on a field that may not
 * exist yet.
 *
 * The session loader is being given an explicit error channel by another
 * change that has not necessarily landed. The assumed contract is: the store
 * carries a falsy value while healthy and, on failure, a string / an `Error` /
 * an object with a `message`. Until that field appears this reads `undefined`
 * on every candidate name and the component behaves exactly as it does today
 * — no error state, no crash, no import of a type that might not exist.
 */
const ERROR_KEYS = [
  'sessionsError',
  'sessionsLoadError',
  'sessionError'
] as const

export function readSessionsError(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null
  const bag = state as Record<string, unknown>
  for (const key of ERROR_KEYS) {
    const raw = bag[key]
    if (!raw) continue
    if (typeof raw === 'string') return raw
    if (raw instanceof Error) return raw.message
    if (typeof raw === 'object') {
      const message = (raw as { message?: unknown }).message
      if (typeof message === 'string' && message) return message
    }
    return 'Something went wrong loading your chats.'
  }
  return null
}

/* ------------------------------------------------------------------ */

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

/**
 * The load FAILED — which is a different fact from "you have no chats", and
 * the reader can act on this one. Never shown for an empty-but-successful
 * load.
 */
const SessionsErrorState = ({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}) => (
  <div className="px-3 py-6">
    <WifiOff className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
    <p className="mt-2 text-[length:var(--text-sm)] font-medium text-[var(--text-secondary)]">
      Couldn&apos;t load your chats
    </p>
    <p className="mt-0.5 text-[length:var(--text-xs)] leading-snug text-[var(--text-muted)]">
      {message}
    </p>
    <button
      type="button"
      onClick={onRetry}
      className={cn(
        'mt-2 inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1',
        'text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)]',
        'transition-colors hover:bg-[var(--accent)] hover:text-[var(--text)]',
        focusRing
      )}
    >
      <RotateCw className="h-3 w-3" aria-hidden />
      Try again
    </button>
  </div>
)

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

  // The whole state is already subscribed here, so the defensive error read
  // costs no extra subscription and cannot churn a selector's identity.
  const storeState = useStore()
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
  } = storeState

  const loadError = readSessionsError(storeState)

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

  /*
    Which entity the currently-visible list belongs to. Identity, not a
    timestamp: this is what tells a genuine switch of agent/db apart from the
    same query being re-run because a dependency's identity changed.
  */
  const requestKey = `${mode}|${agentId ?? ''}|${teamId ?? ''}|${dbId ?? ''}`
  const dataKeyRef = useRef<string | null>(null)
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const wasLoadingRef = useRef(false)

  /*
    Mirrors `useSessionLoader.getSessions`' own precondition, which we cannot
    edit: it early-returns silently — no fetch, no error, no loading flag —
    when the endpoint, entity or db id is missing. Calling it in that state
    used to leave an emptied list and no indication anything had happened, so
    we do not call it, do not blank the list, and let SessionBlankState name
    the actual reason instead.
  */
  const canLoad = Boolean(
    selectedEndpoint && mode && (mode === 'agent' ? agentId : teamId) && dbId
  )

  const loadSessions = useCallback(() => {
    if (!canLoad) return
    dataKeyRef.current = requestKey
    getSessions({ entityType: mode, agentId, teamId, dbId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoad, requestKey, getSessions, mode, agentId, teamId, dbId])

  useEffect(() => {
    /*
      ★ This used to start with `if (isEndpointLoading) return`, which put the
      session list BEHIND initialize() — three sequential calls ending in
      GET /agents, whose payload is 125KB because it ships the agent's entire
      105,113-character system_message to the browser. Nothing in this UI reads
      that field, so the history waited on a download it had no use for.

      Everything this fetch needs — endpoint, mode, agent id, db id — comes off
      the URL and is available on the first render. `canLoad` is the real
      precondition and is checked below; endpoint loading never was.

      ★ The list is NOT blanked before a refetch any more. It used to be
      `setSessionsData([])` on every run of this effect, so the history area
      went empty on each reload and only refilled when the request landed —
      and if the request never landed (see `canLoad` above) it stayed empty
      forever, indistinguishable from having no chats.

      The one case that still clears is a genuine switch of agent/db, where
      keeping the previous entity's sessions on screen would be worse than a
      flash: it would show one client's conversations under another's name.
    */
    if (dataKeyRef.current !== null && dataKeyRef.current !== requestKey) {
      setSessionsData([])
      setSettledKey(null)
    }

    if (!canLoad) {
      dataKeyRef.current = requestKey
      return
    }
    loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, canLoad, loadSessions, setSessionsData])

  /*
    A load has SETTLED for this key once the loader's flag has gone true and
    back to false. That is the only signal available from a hook this change
    may not edit, and it is what separates "loaded, and there is nothing" from
    "we never got an answer" — the two states the old `isEmpty` merged.
  */
  useEffect(() => {
    if (wasLoadingRef.current && !isSessionsLoading) {
      setSettledKey(dataKeyRef.current)
    }
    wasLoadingRef.current = isSessionsLoading
  }, [isSessionsLoading])

  useEffect(() => {
    if (sessionId) setSelectedSessionId(sessionId)
  }, [sessionId])

  const handleSessionClick = useCallback(
    (id: string) => () => setSelectedSessionId(id),
    []
  )

  const groups = useMemo(() => groupSessions(sessionsData), [sessionsData])
  const hasRows = groups.length > 0
  const hasSettled = settledKey === requestKey

  // Keep whatever is on screen while a same-key refetch is in flight; only
  // fall back to the placeholder when there is genuinely nothing to hold.
  //
  // `isEndpointLoading` is deliberately NOT a blanket skeleton condition any
  // more. Rows can now arrive before initialize() finishes (see the fetch
  // effect above), and holding a skeleton over a list we already have is the
  // slow sidebar the user sees. It still counts while we have nothing AND
  // cannot load — that is the genuine "we do not know yet" state, and calling
  // it "No conversations" there would be a lie.
  if (!hydrated || (isSessionsLoading && !hasRows) || (isEndpointLoading && !hasRows && !canLoad)) {
    return (
      <SessionsShell>
        <div className="min-h-0 flex-1 overflow-hidden" aria-busy>
          <SkeletonList skeletonCount={5} />
        </div>
      </SessionsShell>
    )
  }

  const body = (() => {
    // A failed refresh does not throw away a good list — the rows on screen
    // are still the last thing we know to be true.
    if (loadError && !hasRows) {
      return <SessionsErrorState message={loadError} onRetry={loadSessions} />
    }
    if (!hasRows) {
      // Either the load finished and returned nothing, or it was never going
      // to run at all (no endpoint / no agent) — SessionBlankState says which.
      if (hasSettled || !canLoad || !isEndpointActive) {
        return <SessionBlankState />
      }
      // In flight, or about to be. Never claim "no conversations" here.
      return <SkeletonList skeletonCount={5} />
    }
    return groups.map((group) => (
      <section key={group.id} className="pb-1">
        {/*
          Sticky, because the rows are the reason: every session in this
          product is named after the same opening line, so the heading is
          often the only thing on screen saying WHICH band the row under the
          cursor belongs to. It needs the rail's own ground (--bg-secondary)
          or the rows scroll through it.
        */}
        <h3
          className={cn(
            'sticky top-0 z-10 bg-[var(--bg-secondary)] px-2.5 pb-1 pt-2',
            'text-[length:var(--text-2xs)] font-semibold uppercase',
            'tracking-[var(--tracking-tag)] text-[var(--text-muted)]'
          )}
        >
          {group.label}
        </h3>
        <div className="flex flex-col gap-y-0.5">
          {group.sessions.map((entry, idx) => (
            <SessionItem
              key={`${entry?.session_id}-${idx}`}
              currentSessionId={selectedSessionId}
              isSelected={selectedSessionId === entry?.session_id}
              onSessionClick={handleSessionClick(entry?.session_id)}
              session_name={entry?.session_name ?? '-'}
              session_id={entry?.session_id}
              created_at={entry?.created_at}
              updated_at={entry?.updated_at}
            />
          ))}
        </div>
      </section>
    ))
  })()

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
        {body}
      </nav>
    </SessionsShell>
  )
}

export default Sessions
