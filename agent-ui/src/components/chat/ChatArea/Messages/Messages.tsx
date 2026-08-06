import type { ChatMessage, ToolCall } from '@/types/os'

import { AgentMessage, UserMessage } from './MessageItem'
import { useState, useEffect, useRef } from 'react'
import { ReferenceData, Reference } from '@/types/os'
import React, { type FC } from 'react'

import ChatBlankState from './ChatBlankState'
import PickerCardList from '@/components/chat/PickerCardList'
import AskUserCardList from '@/components/chat/AskUserCardList'
import ApprovalPrompt from '@/components/chat/ApprovalPrompt'
import { useStore } from '@/store'
import { Copy, Check, ChevronRight, AlertTriangle, Plus } from 'lucide-react'
import { toolLabel, summariseToolCall, formatRaw } from './toolDisplay'
import type { ToolSummary } from './toolDisplay'

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

/**
 * The raw layer is for spot-checking, not reading. It lives in a scrollable
 * box, so the cap only exists to keep a runaway payload out of the DOM —
 * `quick_info` has measured ~94k characters.
 */
function clip(text: string | null, max = 4000): string | null {
  if (!text) return null
  return text.length > max
    ? `${text.slice(0, max)}\n… ${text.length - max} more characters not shown`
    : text
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
  // Stacked rows rather than pills: full-sentence suggestions wrap instead of
  // being truncated to fit a chip, and the list reads top-to-bottom.
  return (
    <div className="mt-4 flex flex-col">
      <p className="mb-1 text-[11px] uppercase tracking-[0.05em] text-[var(--text-muted)]">
        Follow up
      </p>
      <ul className="flex flex-col border-t border-[var(--border)]">
        {suggestions.map((s, i) => (
          <li key={i} className="border-b border-[var(--border)]">
            <button
              onClick={() => setPendingMessage(s)}
              className="group flex w-full cursor-pointer items-start gap-2.5 py-2 pr-1 text-left text-[13px] leading-[1.5] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)]"
            >
              <Plus
                aria-hidden
                className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[var(--faint)] transition-colors group-hover:text-[var(--text-muted)]"
              />
              <span className="min-w-0 flex-1">{s}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------------------------------------------------------------- *
 * Tool trace — quiet structured events, not chat messages.
 * ---------------------------------------------------------------- */

type EventState = 'running' | 'done' | 'failed'

interface TraceEvent {
  key: string
  /** Layer 2: domain language — "Read the company register", never `quick_info`. */
  label: string
  state: EventState
  duration: string | null
  /**
   * Layer 2: what came back, as a headline plus a few labelled facts — never
   * the payload. See toolDisplay.summariseToolCall.
   */
  summary?: ToolSummary | null
  /** Layer 3 (debugging): raw identifiers, hidden until the row is opened. */
  toolName?: string
  args?: string | null
  result?: string | null
}

/** Colour + glyph per state, so state is legible without reading the word. */
const STATE_STYLE: Record<EventState, { dot: string; text: string; label: string }> = {
  running: { dot: 'bg-[var(--warn)] animate-pulse', text: 'text-[var(--text)]', label: 'Running' },
  done: { dot: 'bg-[var(--ok)]', text: 'text-[var(--text-secondary)]', label: 'Done' },
  failed: { dot: 'bg-[var(--danger)]', text: 'text-[var(--danger-strong)]', label: 'Failed' }
}

/** Tone → colour for the one-line result headline. Tokens only, no hexes. */
const SUMMARY_TONE: Record<NonNullable<TraceEvent['summary']>['tone'], string> = {
  neutral: 'text-[var(--text-muted)]',
  attention: 'text-[var(--warn)]',
  error: 'text-[var(--danger-strong)]'
}

/**
 * Layer 3. The payload the tool actually returned, collapsed behind an
 * explicit toggle — a `get_company` result carries every director's NRC and a
 * `quick_info` result runs to tens of thousands of characters, so it is never
 * printed inline. Monospace, capped height, scrolls inside itself.
 */
const RawPayload = ({
  toolName,
  args,
  result
}: {
  toolName: string
  args?: string | null
  result?: string | null
}) => {
  const [open, setOpen] = useState(false)
  if (!args && !result) {
    return (
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--faint)]">
        {toolName}
      </p>
    )
  }

  return (
    <div className="flex flex-col items-start">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--faint)] transition-colors hover:text-[var(--text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--border-strong)]"
      >
        <ChevronRight
          aria-hidden
          className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        raw · {toolName}
      </button>
      {open && (
        <div className="mt-1 w-full">
          {args && (
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-2 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5] text-[var(--text-secondary)]">
              {args}
            </pre>
          )}
          {result && (
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-2 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5] text-[var(--text-secondary)]">
              {result}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One timeline entry. Progressive disclosure, three clicks deep: the row shows
 * the domain label and a one-line result headline; opening it shows the
 * structured facts; opening "raw" inside that shows the payload.
 */
const ToolEventRow = ({ event }: { event: TraceEvent }) => {
  const style = STATE_STYLE[event.state]
  const [open, setOpen] = useState(false)
  const facts = event.summary?.facts ?? []
  const hasDetail = Boolean(event.toolName) || facts.length > 0

  const Dot = (
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
  )

  const Body = (
    <>
      <span
        className={
          event.state === 'running'
            ? 'ls-shimmer text-[12.5px]'
            : `text-[12.5px] ${event.state === 'failed' ? 'text-[var(--danger-strong)]' : 'text-[var(--text)]'}`
        }
      >
        {event.label}
      </span>
      {event.summary && (
        <span className={`min-w-0 truncate text-[12px] ${SUMMARY_TONE[event.summary.tone]}`}>
          {event.summary.headline}
        </span>
      )}
      {event.duration && (
        <span className="ml-auto shrink-0 font-[family-name:var(--font-mono)] text-[11px] tabular-nums text-[var(--faint)]">
          {event.duration}
        </span>
      )}
      <span className="sr-only">{style.label}</span>
    </>
  )

  if (!hasDetail) {
    return (
      <li className="relative flex items-baseline gap-2 py-1 pl-[18px]">
        {Dot}
        {Body}
      </li>
    )
  }

  return (
    <li className="relative pl-[18px]">
      {Dot}
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-baseline gap-2 py-1 text-left transition-colors hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--border-strong)]"
      >
        {Body}
      </button>
      {open && (
        <div
          className="mb-1.5 ml-0 flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] p-2"
          style={{
            // Alpha modifiers on var() colours emit nothing — mix instead.
            background: 'color-mix(in srgb, var(--accent) 60%, transparent)'
          }}
        >
          {facts.length > 0 && (
            <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
              {facts.map((f, i) => (
                <React.Fragment key={`${f.label}-${i}`}>
                  <dt className="whitespace-nowrap text-[11px] uppercase tracking-[0.05em] text-[var(--text-muted)]">
                    {f.label}
                  </dt>
                  <dd className="min-w-0 break-words text-[12px] text-[var(--text)]">{f.value}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}
          {event.toolName && (
            <RawPayload toolName={event.toolName} args={event.args} result={event.result} />
          )}
        </div>
      )}
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
      // ToolExecution.result is the session-history field; streaming fills
      // `content` instead. Either can carry the payload we summarise.
      const payload = tc.result ?? tc.content
      return {
        key: tc.tool_call_id || `${tc.tool_name}-${i}`,
        label: toolLabel(tc.tool_name),
        state,
        duration: state === 'running' ? null : formatSeconds(tc.metrics?.time),
        // Only ever a summary object — the payload itself stays behind the
        // raw toggle in the opened row.
        summary: state === 'running' ? null : summariseToolCall(tc.tool_name, payload),
        toolName: tc.tool_name,
        args: clip(formatRaw(tc.tool_args)),
        result: clip(formatRaw(payload))
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

        {/* Pre-tool, pre-content gap: the Analyzing pill carries the wait.
            Once tools stream, ToolTrace shows the pill + timeline instead;
            once text flows, the inline cursor takes over. */}
        {isStillStreaming &&
          !hasContent &&
          toolCalls.length === 0 &&
          reasoningTitles.length === 0 && <AnalyzingPill />}

        {/* Interactive people pickers (paused HITL run) */}
        <PickerCardList requests={message.picker_requests} />

        {/* Structured question cards (paused HITL run) */}
        <AskUserCardList requests={message.ask_user_requests} />

        {/* The approval a stalled preview owed. Not a paused run — answering
            sends the choice as the next message. Only ever set on the last
            message, by the silent-stop guard in useAIStreamHandler. */}
        {!isStillStreaming && (
          <ApprovalPrompt approval={message.pending_approval} />
        )}

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
