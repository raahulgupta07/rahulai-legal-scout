import type { ChatMessage, ToolCall } from '@/types/os'

import { AgentMessage, UserMessage } from './MessageItem'
import { useState, useEffect, useRef } from 'react'
import { ReferenceData, Reference } from '@/types/os'
import React, { type FC } from 'react'

import ChatBlankState from './ChatBlankState'
import PickerCardList from '@/components/chat/PickerCardList'
import { useStore } from '@/store'
import { Copy, Check, ChevronRight, AlertTriangle } from 'lucide-react'

// Instant fallback suggestions (shown immediately while LLM suggestions load)
function getInstantSuggestions(content: string): string[] {
  const lower = content.toLowerCase()
  if (lower.includes('template') && lower.includes('upload'))
    return ["Show all templates", "List all companies"]
  if (lower.includes('agm') || lower.includes('annual general'))
    return ["Show all templates", "List all companies"]
  if (lower.includes('company') || lower.includes('companies'))
    return ["Create AGM for City Holdings", "Show all templates"]
  if (lower.includes('director') || lower.includes('consent'))
    return ["List all companies", "Show all templates"]
  return ["Show all templates", "List all companies"]
}

/** Tool names are snake_case identifiers; show them as readable labels. */
function formatToolName(name: string): string {
  const label = name.replace(/_/g, ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function formatSeconds(ms?: number): string | null {
  if (!ms && ms !== 0) return null
  return `${(ms / 1000).toFixed(2)}s`
}

// Live timer that ticks every 100ms while waiting for response
const LiveTimer = () => {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startRef.current)
    }, 100)
    return () => clearInterval(interval)
  }, [])

  return (
    <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] tabular-nums text-[var(--text-muted)]">
      {(elapsed / 1000).toFixed(1)}s
    </span>
  )
}

// Static badge showing the final response time
const ResponseTime = ({ ms }: { ms: number }) => (
  <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] tabular-nums text-[var(--text-muted)]">
    {(ms / 1000).toFixed(1)}s
  </span>
)

interface MessageListProps {
  messages: ChatMessage[]
}

interface MessageWrapperProps {
  message: ChatMessage
  isLastMessage: boolean
}

interface ReferenceProps {
  references: ReferenceData[]
}

interface ReferenceItemProps {
  reference: Reference
}

const ReferenceItem: FC<ReferenceItemProps> = ({ reference }) => (
  <div className="flex w-[190px] cursor-default flex-col gap-1 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-3">
    <p className="truncate text-[length:var(--text-sm)] font-medium text-[var(--text)]">
      {reference.name}
    </p>
    <p className="truncate text-[length:var(--text-xs)] text-[var(--text-muted)]">
      {reference.content}
    </p>
  </div>
)

const References: FC<ReferenceProps> = ({ references }) => (
  <div className="flex flex-col gap-3">
    {references.map((referenceData, index) => (
      <div key={`${referenceData.query}-${index}`} className="flex flex-wrap gap-2">
        {referenceData.references.map((reference, refIndex) => (
          <ReferenceItem
            key={`${reference.name}-${reference.meta_data.chunk}-${refIndex}`}
            reference={reference}
          />
        ))}
      </div>
    ))}
  </div>
)

const CopyButton = ({ content }: { content: string }) => {
  const [copied, setCopied] = React.useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      aria-label={copied ? 'Copied to clipboard' : 'Copy reply'}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-xl)] px-2 py-1 text-[length:var(--text-xs)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
    >
      {copied ? (
        <><Check className="h-3.5 w-3.5 text-[var(--ok-strong)]" /> Copied</>
      ) : (
        <><Copy className="h-3.5 w-3.5" /> Copy</>
      )}
    </button>
  )
}

const SuggestionButtons = ({ content, isLast, userQuestion }: { content: string, isLast: boolean, userQuestion?: string }) => {
  const { setPendingMessage } = useStore()
  const [suggestions, setSuggestions] = React.useState<string[]>([])
  const fetchedRef = useRef(false)

  React.useEffect(() => {
    if (!isLast || !content || fetchedRef.current) return
    // Show instant fallback first
    setSuggestions(getInstantSuggestions(content))
    // Then fetch LLM-powered suggestions
    fetchedRef.current = true
    const token = typeof window !== 'undefined' ? localStorage.getItem('ls_token') : ''
    fetch('/api/suggest-followups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
      body: JSON.stringify({ question: userQuestion || '', answer: content.slice(0, 500) })
    })
      .then(r => r.json())
      .then(d => { if (d.suggestions?.length) setSuggestions(d.suggestions.slice(0, 3)) })
      .catch(() => {})
  }, [isLast, content, userQuestion])

  if (!isLast || !content || suggestions.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {suggestions.map((s, i) => (
        <button
          key={i}
          onClick={() => setPendingMessage(s)}
          className="cursor-pointer rounded-[999px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-[length:var(--text-sm)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          {s}
        </button>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * Tool trace — quiet structured events, not chat messages.
 * ---------------------------------------------------------------- */

type EventState = 'running' | 'done' | 'failed'

interface TraceEvent {
  key: string
  label: string
  state: EventState
  duration: string | null
}

/** Colour + glyph per state, so state is legible without reading the word. */
const STATE_STYLE: Record<EventState, { dot: string; text: string; label: string }> = {
  running: { dot: 'bg-[var(--warn)] animate-pulse', text: 'text-[var(--text)]', label: 'Running' },
  done: { dot: 'bg-[var(--ok)]', text: 'text-[var(--text-secondary)]', label: 'Done' },
  failed: { dot: 'bg-[var(--danger)]', text: 'text-[var(--danger-strong)]', label: 'Failed' }
}

/** One timeline entry: state dot on the rail, label, duration. */
const ToolEventRow = ({ event }: { event: TraceEvent }) => {
  const style = STATE_STYLE[event.state]
  return (
    <li className="relative flex items-baseline gap-2 py-1 pl-[18px]">
      <span
        aria-hidden
        className={`absolute left-[-3px] top-[9px] h-[7px] w-[7px] rounded-full ${
          event.state === 'done'
            ? 'bg-[var(--ok)]'
            : event.state === 'running'
              ? 'animate-pulse bg-[var(--brand)]'
              : 'bg-[var(--danger)]'
        }`}
      />
      <span
        className={
          event.state === 'running'
            ? 'ls-shimmer text-[12.5px]'
            : `text-[12.5px] ${event.state === 'failed' ? 'text-[var(--danger-strong)]' : 'text-[var(--text)]'}`
        }
      >
        {event.label}
      </span>
      {event.duration && (
        <span className="shrink-0 font-[family-name:var(--font-mono)] text-[11px] tabular-nums text-[var(--faint)]">
          {event.duration}
        </span>
      )}
      <span className="sr-only">{style.label}</span>
    </li>
  )
}

/** GPT-style pill shown above the timeline while the run is in flight. */
const AnalyzingPill = () => (
  <span className="inline-flex items-center gap-2 self-start rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-[13px]">
    <span className="ls-shimmer font-medium">Analyzing your request</span>
    <span aria-hidden className="inline-flex gap-[3px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1 w-1 animate-pulse rounded-full bg-[var(--text-muted)]"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </span>
  </span>
)

/**
 * Collapsed to a single summary line when everything succeeded — the user
 * scans past it. Auto-opens while work is in flight or when a step failed,
 * because those are the only times the detail is worth the vertical space.
 */
const ToolTrace = ({
  toolCalls,
  reasoningTitles,
  isStreaming
}: {
  toolCalls: ToolCall[]
  reasoningTitles: string[]
  isStreaming: boolean
}) => {
  const events: TraceEvent[] = [
    ...reasoningTitles.map((title, i) => ({
      key: `reasoning-${i}`,
      label: title,
      state: 'done' as EventState,
      duration: null
    })),
    ...toolCalls.map((tc, i) => {
      const isLastCall = i === toolCalls.length - 1
      const state: EventState = tc.tool_call_error
        ? 'failed'
        : isStreaming && isLastCall
          ? 'running'
          : 'done'
      return {
        key: tc.tool_call_id || `${tc.tool_name}-${i}`,
        label: formatToolName(tc.tool_name),
        state,
        duration: state === 'running' ? null : formatSeconds(tc.metrics?.time)
      }
    })
  ]

  const failedCount = events.filter((e) => e.state === 'failed').length
  const runningCount = events.filter((e) => e.state === 'running').length
  const needsAttention = failedCount > 0 || runningCount > 0

  // Follows the run: opens when something is in flight or broken, folds itself
  // away once the run lands clean. A manual toggle is never clobbered, since
  // this only fires when needsAttention actually flips.
  const [open, setOpen] = useState(needsAttention)
  useEffect(() => {
    setOpen(needsAttention)
  }, [needsAttention])

  if (events.length === 0) return null

  const totalMs = toolCalls.reduce((sum, tc) => sum + (tc.metrics?.time ?? 0), 0)
  const summaryState: EventState = failedCount > 0 ? 'failed' : runningCount > 0 ? 'running' : 'done'

  // Option D (B+C mix): while running, a gradient "Analyzing" pill sits above
  // a dot timeline of tool activity; when finished it all collapses to one
  // quiet "✓ N steps · Xs" line that re-expands on click.
  const Timeline = (
    <ul className="relative ml-[9px] mt-2 flex flex-col">
      <span
        aria-hidden
        className="absolute bottom-[10px] left-[0px] top-[10px] w-[1.5px] bg-[var(--border)]"
      />
      {events.map((event) => (
        <ToolEventRow key={event.key} event={event} />
      ))}
    </ul>
  )

  if (summaryState === 'running') {
    return (
      <div className="mb-2 flex flex-col">
        <AnalyzingPill />
        {Timeline}
      </div>
    )
  }

  const summary =
    failedCount > 0
      ? `${failedCount} of ${events.length} steps failed`
      : `${events.length} ${events.length === 1 ? 'step' : 'steps'}${totalMs ? ` · ${formatSeconds(totalMs)}` : ''}`

  return (
    <div className="mb-2 flex flex-col items-start">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-2 text-left text-[12.5px] text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--border-strong)]"
      >
        <ChevronRight
          aria-hidden
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {summaryState === 'done' ? (
          <Check className="h-3 w-3 shrink-0 text-[var(--ok)]" aria-hidden />
        ) : (
          <AlertTriangle className="h-3 w-3 shrink-0 text-[var(--danger-strong)]" aria-hidden />
        )}
        <span className={summaryState === 'failed' ? 'text-[var(--danger-strong)]' : ''}>
          {summary}
        </span>
      </button>
      {open && Timeline}
    </div>
  )
}

/** Shimmering label + caret shown while tokens are still arriving. */
const StreamingCaret = () => (
  <span className="inline-flex items-center gap-2">
    <span
      aria-hidden
      className="inline-block h-3.5 w-[2px] animate-pulse bg-[var(--brand)]"
    />
    <span className="ls-shimmer text-[length:var(--text-xs)]">Responding…</span>
  </span>
)

const AgentMessageWrapper = ({ message, isLastMessage }: MessageWrapperProps) => {
  const isStreaming = useStore((state) => state.isStreaming)
  const toolCalls = message.tool_calls ?? []
  const reasoningTitles = (message.extra_data?.reasoning_steps ?? []).map((s) => s.title)
  const hasRefs = (message.extra_data?.references?.length ?? 0) > 0
  const hasContent = Boolean(message.content && message.content.trim() !== '')
  const isStillStreaming = isLastMessage && isStreaming

  return (
    <div className="flex items-start gap-3">
      {/* Agent identity mark — square against the pill-shaped user turn. */}
      <div
        aria-hidden
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--surface-inverse)]"
      >
        <span className="font-[family-name:var(--font-display)] text-[length:var(--text-2xs)] font-bold tracking-[var(--tracking-tag)] text-[var(--text-inverse)]">
          LS
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <ToolTrace
          toolCalls={toolCalls}
          reasoningTitles={reasoningTitles}
          isStreaming={isStillStreaming}
        />

        {hasRefs && (
          <div className="mb-3">
            <p className="mb-1.5 text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-muted)]">
              Sources
            </p>
            <References references={message.extra_data!.references!} />
          </div>
        )}

        {hasContent && (
          <AgentMessage message={message} isStreaming={isStillStreaming} />
        )}

        {/* The label only fills the silent gap before tokens arrive — once
            text is flowing the inline cursor in AgentMessage carries it. */}
        {isStillStreaming && !hasContent && <StreamingCaret />}

        {/* Interactive people pickers (paused HITL run) */}
        <PickerCardList requests={message.picker_requests} />

        {!isStillStreaming && hasContent && (
          <div className="-ml-2 mt-2 flex items-center">
            <CopyButton content={message.content || ''} />
          </div>
        )}

        {/* Follow-ups only after the answer settles — never mid-stream. */}
        {hasContent && !isStillStreaming && (
          <SuggestionButtons
            content={message.content || ''}
            isLast={isLastMessage}
            userQuestion={(message as ChatMessage & { _userQuestion?: string })._userQuestion}
          />
        )}
      </div>
    </div>
  )
}

const Messages = ({ messages }: MessageListProps) => {
  if (messages.length === 0) {
    return <ChatBlankState />
  }

  // Build timing map: for each agent message, compute elapsed time from previous user message
  const timings: Record<number, number> = {}
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'agent' && messages[i - 1].role === 'user') {
      const userTime = messages[i - 1].created_at ? new Date(messages[i - 1].created_at * 1000).getTime() : 0
      const agentTime = messages[i].created_at ? new Date(messages[i].created_at * 1000).getTime() : 0
      if (userTime && agentTime && agentTime > userTime) {
        timings[i] = agentTime - userTime
      }
    }
  }

  const lastMessage = messages[messages.length - 1]
  const isWaitingForResponse = lastMessage?.role === 'user'

  return (
    <>
      {messages.map((message, index) => {
        const key = `${message.role}-${message.created_at}-${index}`
        const isLastMessage = index === messages.length - 1

        const msgDate = message.created_at
          ? new Date(message.created_at * 1000)
          : null
        // Old sessions carry malformed stamps — a tooltip reading "Invalid
        // Date" is worse than none.
        const msgTime =
          msgDate && !Number.isNaN(msgDate.getTime())
            ? msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })
            : null

        if (message.role === 'agent') {
          // Find the previous user message for suggestion context
          const prevUserMsg = index > 0 && messages[index - 1]?.role === 'user' ? messages[index - 1].content : ''
          const msgWithContext = { ...message, _userQuestion: prevUserMsg }
          return (
            <div
              key={key}
              className="flex flex-col gap-1.5"
              title={msgTime ?? undefined}
            >
              <AgentMessageWrapper
                message={msgWithContext}
                isLastMessage={isLastMessage}
              />
              {/* Clock time lives in the hover title; only the response
                  duration earns a visible line. */}
              {timings[index] && (
                <div className="ml-9 flex items-center text-[length:var(--text-2xs)] text-[var(--text-muted)]">
                  <ResponseTime ms={timings[index]} />
                </div>
              )}
            </div>
          )
        }
        return (
          <div
            key={key}
            className="flex flex-col gap-1.5"
            title={msgTime ?? undefined}
          >
            <UserMessage message={message} />
            {/* bow-style working row: quiet, unboxed, spinner + elapsed. */}
            {isLastMessage && isWaitingForResponse && (
              <div className="mt-3 flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-[var(--border-strong)] border-t-transparent"
                />
                <span className="ls-shimmer">Working</span>
                <LiveTimer />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

export default Messages
