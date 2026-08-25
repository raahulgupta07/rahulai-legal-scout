import React from 'react'
import { useStore } from '@/store'
import { useQueryState } from 'nuqs'
import { MessagesSquare, PlugZap, Bot } from 'lucide-react'

/**
 * "No sessions yet" is only one of four reasons this list can be empty, and
 * the other three are fixable by the reader. Say which one it is.
 */
const SessionBlankState = () => {
  const { selectedEndpoint, isEndpointActive } = useStore()
  const [agentId] = useQueryState('agent')

  const {
    icon: Icon,
    headline,
    detail
  } = (() => {
    switch (true) {
      case !selectedEndpoint:
        return {
          icon: PlugZap,
          headline: 'No endpoint set',
          detail: 'Set an endpoint under Developer to load history.'
        }
      case !isEndpointActive:
        return {
          icon: PlugZap,
          headline: 'Endpoint offline',
          detail: 'Reconnect to the endpoint to load history.'
        }
      case !agentId:
        return {
          icon: Bot,
          headline: 'No agent selected',
          detail: 'Choose an agent to see its conversations.'
        }
      default:
        return {
          icon: MessagesSquare,
          headline: 'No conversations yet',
          detail: 'Ask for a document and this list fills in.'
        }
    }
  })()

  return (
    <div className="px-3 py-6">
      <Icon className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
      <p className="mt-2 text-[length:var(--text-sm)] font-medium text-[var(--text-secondary)]">
        {headline}
      </p>
      <p className="mt-0.5 text-[length:var(--text-xs)] leading-snug text-[var(--text-muted)]">
        {detail}
      </p>
    </div>
  )
}

export default SessionBlankState
