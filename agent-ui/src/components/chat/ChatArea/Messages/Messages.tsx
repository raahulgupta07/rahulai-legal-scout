import type { ChatMessage } from '@/types/os'

import { AgentMessage, UserMessage } from './MessageItem'
import Tooltip from '@/components/ui/tooltip'
import { memo, useState, useEffect, useRef } from 'react'
import {
  ToolCallProps,
  ReasoningStepProps,
  ReasoningProps,
  ReferenceData,
  Reference
} from '@/types/os'
import React, { type FC } from 'react'

import Icon from '@/components/ui/icon'
import ChatBlankState from './ChatBlankState'
import PickerCardList from '@/components/chat/PickerCardList'
import AgentThinkingLoader from './AgentThinkingLoader'
import { useStore } from '@/store'
import { Copy, Check } from 'lucide-react'

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
    <span className="inline-flex items-center gap-1.5 text-xs text-[#383832] font-brutalist font-bold">
      <span className="inline-block h-2 w-2 bg-[#007518] animate-pulse" />
      {(elapsed / 1000).toFixed(1)}s
    </span>
  )
}

// Static badge showing the final response time
const ResponseTime = ({ ms }: { ms: number }) => (
  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#383832]/50 font-brutalist uppercase tracking-wider">
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
  <div className="relative flex h-[63px] w-[190px] cursor-default flex-col justify-between overflow-hidden rounded-md bg-background-secondary p-3 transition-colors hover:bg-background-secondary/80">
    <p className="text-base font-medium text-primary">{reference.name}</p>
    <p className="truncate text-sm text-primary/40">{reference.content}</p>
  </div>
)

const References: FC<ReferenceProps> = ({ references }) => (
  <div className="flex flex-col gap-4">
    {references.map((referenceData, index) => (
      <div
        key={`${referenceData.query}-${index}`}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-wrap gap-3">
          {referenceData.references.map((reference, refIndex) => (
            <ReferenceItem
              key={`${reference.name}-${reference.meta_data.chunk}-${refIndex}`}
              reference={reference}
            />
          ))}
        </div>
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
    <button onClick={handleCopy} className="inline-flex items-center gap-1 px-2 py-1 border border-[#383832]/30 text-[10px] font-bold uppercase tracking-wider text-[#383832]/60 hover:bg-[#383832]/5 transition-colors cursor-pointer font-brutalist">
      {copied ? <><Check className="w-3 h-3 text-[#00fc40]" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
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
    <div className="flex flex-wrap gap-2 mt-3 font-brutalist">
      {suggestions.map((s, i) => (
        <button key={i} onClick={() => setPendingMessage(s)}
          className="px-3 py-2 text-[11px] font-bold uppercase tracking-[0.05em] text-[#383832] bg-[#fffff0]
                     border-[2px] border-[#383832] border-r-[3px] border-b-[3px]
                     hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-[3px_3px_0px_0px_#383832]
                     active:translate-x-0 active:translate-y-0 active:shadow-none transition-all cursor-pointer">
          {s}
        </button>
      ))}
    </div>
  )
}

const TraceToggle = ({ message }: { message: ChatMessage }) => {
  const [open, setOpen] = React.useState(false)
  const hasTools = message.tool_calls && message.tool_calls.length > 0
  if (!hasTools) return null
  return (
    <div className="mt-1 font-brutalist">
      <button onClick={() => setOpen(!open)}
        className="w-full text-left bg-[#262622] text-[#e8e8d8] px-3 py-1.5 cursor-pointer hover:bg-[#2a2a25] transition-colors">
        <div className="flex items-center justify-between text-xs">
          <span><span className="text-[#00fc40]">$</span> trace</span>
          <span className="opacity-40">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && (
        <div className="bg-[#262622] text-[#e8e8d8] px-3 pb-2 border-t border-[#e8e8d8]/10">
          {message.tool_calls!.map((tc, i) => (
            <div key={i} className="flex items-center justify-between text-[11px] py-1 opacity-60">
              <span><span className="text-[#00fc40] mr-1">✓</span> {tc.tool_name}</span>
              <span className="opacity-40">{tc.metrics?.time ? `${(tc.metrics.time / 1000).toFixed(2)}s` : '—'}</span>
            </div>
          ))}
          <div className="flex items-center gap-4 text-[9px] uppercase tracking-wider opacity-40 pt-1 border-t border-[#e8e8d8]/10 mt-1">
            <span>Steps: {message.tool_calls!.length}</span>
            <span>Model: gpt-4o-mini</span>
          </div>
        </div>
      )}
    </div>
  )
}

const AgentMessageWrapper = ({ message, isLastMessage }: MessageWrapperProps) => {
  const isStreaming = useStore((state) => state.isStreaming)
  const hasTools = message.tool_calls && message.tool_calls.length > 0
  const hasReasoning = message.extra_data?.reasoning_steps && message.extra_data.reasoning_steps.length > 0
  const hasRefs = message.extra_data?.references && message.extra_data.references.length > 0
  const hasContent = message.content && message.content.trim() !== ''
  const isStillStreaming = isLastMessage && isStreaming

  return (
    <div className="flex items-start gap-3 font-brutalist">
      {/* Agent icon */}
      <div className="flex-shrink-0 mt-1">
        <div className="w-6 h-6 bg-[#262622] flex items-center justify-center">
          <span className="text-[#e8e8d8] text-[9px] font-black">LS</span>
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-0">
        {/* CLI Terminal Block */}
        <div className="bg-[#262622] text-[#e8e8d8] p-3 rounded-none">
          <p className="text-xs font-bold opacity-50 mb-1">
            <span className="text-[#00fc40]">$</span> scout exec <span className="opacity-30">--agent legal</span>
          </p>
          {hasReasoning && message.extra_data!.reasoning_steps!.map((step, i) => (
            <p key={i} className="text-xs opacity-60 ml-2">
              <span className="text-[#00fc40] mr-1">&gt;</span>
              <span className="text-[#00fc40] mr-1">✓</span>
              {step.title}
            </p>
          ))}
          {hasTools && message.tool_calls!.map((toolCall, i) => (
            <p key={toolCall.tool_call_id || `${toolCall.tool_name}-${i}`} className="text-xs opacity-60 ml-2">
              <span className="text-[#00fc40] mr-1">&gt;</span>
              <span className="text-[#00fc40] mr-1">✓</span>
              {toolCall.tool_name}
            </p>
          ))}
          {!hasTools && !hasReasoning && (
            <p className="text-xs opacity-60 ml-2">
              <span className="text-[#00fc40] mr-1">&gt;</span>
              <span className="text-[#00fc40] mr-1">✓</span>
              direct response
            </p>
          )}
          <div className="flex items-center justify-between text-xs mt-1">
            <p>
              <span className="text-[#00fc40]">$</span>{' '}
              <span className="text-[#00fc40] font-bold">done</span>
              <span className="opacity-30"> · {hasTools || hasReasoning ? `${(hasTools ? message.tool_calls!.length : 0) + (hasReasoning ? message.extra_data!.reasoning_steps!.length : 0)} steps` : 'direct response'}</span>
            </p>
            <span className="opacity-30">0.00s</span>
          </div>
        </div>

        {/* References */}
        {hasRefs && (
          <div className="bg-[#383832] text-[#feffd6] p-3 border-l-[3px] border-[#00fc40] mt-0">
            <References references={message.extra_data!.references!} />
          </div>
        )}

        {/* Answer Box — show loading animation until streaming finishes */}
        <div style={{ backgroundColor: '#fffff0', color: '#383832', borderColor: '#383832', borderWidth: '2px', borderStyle: 'solid', borderRightWidth: '4px', borderBottomWidth: '4px', boxShadow: '4px 4px 0px 0px #383832' }} className="p-4 mt-0">
          {hasContent && <AgentMessage message={message} />}
          {isStillStreaming && (
            <div className={`flex items-center gap-2 ${hasContent ? 'mt-3 pt-3 border-t border-[#383832]/10' : ''}`}>
              <svg className="w-4 h-4 text-[#383832]/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="inline-flex gap-[3px]">
                <span className="inline-block size-[6px] bg-[#007518] animate-[cliBlink_1.2s_infinite_0s]" />
                <span className="inline-block size-[6px] bg-[#ff9d00] animate-[cliBlink_1.2s_infinite_0.2s]" />
                <span className="inline-block size-[6px] bg-[#be2d06] animate-[cliBlink_1.2s_infinite_0.4s]" />
              </span>
              <span className="text-[10px] font-bold text-[#383832]/30 uppercase tracking-wider font-brutalist">streaming</span>
            </div>
          )}
          {!isStillStreaming && hasContent && (
            <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-[#383832]/10">
              <CopyButton content={message.content || ''} />
            </div>
          )}
        </div>

        {/* Interactive people pickers (paused HITL run) */}
        <PickerCardList requests={message.picker_requests} />

        {/* Trace toggle */}
        <TraceToggle message={message} />

        {/* Auto-suggestions — only on last message */}
        {hasContent && <SuggestionButtons content={message.content || ''} isLast={isLastMessage} userQuestion={(message as any)._userQuestion} />}
      </div>
    </div>
  )
}
const Reasoning: FC<ReasoningStepProps> = ({ index, stepTitle }) => (
  <div className="flex items-center gap-2 text-secondary">
    <div className="flex h-[20px] items-center rounded-md bg-background-secondary p-2">
      <p className="text-sm">STEP {index + 1}</p>
    </div>
    <p className="text-sm">{stepTitle}</p>
  </div>
)
const Reasonings: FC<ReasoningProps> = ({ reasoning }) => (
  <div className="flex flex-col items-start justify-center gap-2">
    {reasoning.map((title, index) => (
      <Reasoning
        key={`${title.title}-${title.action}-${index}`}
        stepTitle={title.title}
        index={index}
      />
    ))}
  </div>
)

const ToolComponent = memo(({ tools }: ToolCallProps) => (
  <div className="cursor-default bg-[#383832] text-[#feffd6] px-3 py-1.5 text-xs border-l-[3px] border-[#007518]">
    <p className="font-brutalist font-bold uppercase tracking-wider">
      <span className="text-[#00fc40] mr-1">$</span>
      {tools.tool_name}
    </p>
  </div>
))
ToolComponent.displayName = 'ToolComponent'
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

        const msgTime = message.created_at
          ? new Date(message.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()
          : null

        if (message.role === 'agent') {
          // Find the previous user message for suggestion context
          const prevUserMsg = index > 0 && messages[index - 1]?.role === 'user' ? messages[index - 1].content : ''
          const msgWithContext = { ...message, _userQuestion: prevUserMsg } as any
          return (
            <div key={key} className="flex flex-col gap-1">
              <AgentMessageWrapper
                message={msgWithContext}
                isLastMessage={isLastMessage}
              />
              <div className="ml-9 mt-1 flex items-center gap-3">
                {timings[index] && <ResponseTime ms={timings[index]} />}
                {msgTime && <span className="text-[10px] font-bold text-[#383832]/40 uppercase tracking-wider font-brutalist">{msgTime} · AGENT</span>}
              </div>
            </div>
          )
        }
        return (
          <div key={key} className="flex flex-col gap-1">
            <UserMessage message={message} />
            {msgTime && (
              <div className="text-right mr-9 mt-0.5">
                <span className="text-[10px] font-bold text-[#383832]/40 uppercase tracking-wider font-brutalist">{msgTime} · READ</span>
              </div>
            )}
            {isLastMessage && isWaitingForResponse && (
              <div className="flex items-start gap-3 mt-3">
                <div className="w-6 h-6 bg-[#262622] flex items-center justify-center shrink-0">
                  <span className="text-[#e8e8d8] text-[9px] font-black">LS</span>
                </div>
                <div className="flex-1 bg-[#262622] text-[#e8e8d8] p-3">
                  <AgentThinkingLoader />
                  <div className="mt-1"><LiveTimer /></div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

export default Messages
