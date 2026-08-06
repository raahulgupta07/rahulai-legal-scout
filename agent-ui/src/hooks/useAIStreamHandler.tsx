import { useCallback, useRef } from 'react'
import { toast } from 'sonner'

import { APIRoutes } from '@/api/routes'
import { buildContinueRunRequest, buildAskUserContinueRequest } from '@/api/os'

import useChatActions from '@/hooks/useChatActions'
import { useStore } from '../store'
import {
  RunEvent,
  RunResponseContent,
  type AskUserAnswerMap,
  type AskUserRequest,
  type PickerRequest,
  type PickerSelectionEntry,
  type RunResponse
} from '@/types/os'
import { constructEndpointUrl } from '@/lib/constructEndpointUrl'
import useAIResponseStream from './useAIResponseStream'
import { ToolCall } from '@/types/os'
import { useQueryState } from 'nuqs'
import { getJsonMarkdown } from '@/lib/utils'
import {
  buildPickerRequest,
  isPickerTool,
  summariseSelection
} from '@/components/chat/pickerPayload'
import {
  buildAskUserRequest,
  isAskUserTool,
  summariseAnswers
} from '@/components/chat/askUserPayload'

const getLocalUserId = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    const user = JSON.parse(localStorage.getItem('ls_user') || 'null')
    return user?.id != null ? String(user.id) : null
  } catch (error) {
    console.warn('Could not read ls_user from localStorage', error)
    return null
  }
}

/**
 * Agno's built-in "paused" narration (agno/utils/response.py). It describes the
 * framework's own state, never the user's task, so it is kept out of the
 * transcript. Covers every variant: confirmation / user input / external
 * execution, alone or combined.
 */
const AGNO_PAUSE_BOILERPLATE =
  /^I have tools to execute, but (I need|it needs)\b.*\.$/i

/**
 * Content made of nothing but structural JSON punctuation and whitespace. A
 * measured turn finished with its ENTIRE content being `]}` — the tail of a
 * truncated tool payload — which painted in the transcript as if it were the
 * answer AND reset the nudge counter, cancelling the auto-`continue` that
 * would have recovered the turn. Junk is not the agent talking. The empty
 * string matches too, which is intended: empty is not real output either.
 */
const JUNK_CONTENT = /^[\s[\]{}(),:"'`]*$/

/** True only for a string carrying something other than structural noise. */
const isRealContent = (c: unknown): c is string =>
  typeof c === 'string' && !JUNK_CONTENT.test(c)

/**
 * How many silent stops in a row we quietly retry before telling the user.
 * Measured behaviour: a single conversation stalled three times, so one retry
 * is too few — but retrying without limit re-runs the document tools and
 * duplicates output.
 */
const MAX_CONSECUTIVE_NUDGES = 3

/**
 * Tools that can END a turn on their own, with nothing owed to the user.
 */
const CLOSABLE_DOC_TOOLS = new Set([
  'generate_document',
  'generate_dica_extract'
])

/**
 * Tools that leave a DECISION outstanding when the turn dies.
 *
 * `preview_doc` renders the whole field table and then owes an approval card.
 * Closing the turn on its text alone would leave the user holding a preview
 * with no way to say yes, which is why it was excluded from CLOSABLE_DOC_TOOLS
 * — the answer is not to close it silently but to draw the decision the model
 * failed to ask for.
 *
 * This became the dominant stall only after the tool started working at all:
 * the prompt named `preview_document`, which is not a registered tool, so the
 * required preview step was unreachable and the model skipped to generation.
 * With the name fixed, preview runs — and stalls — in nearly every conversation.
 */
const APPROVAL_DOC_TOOLS = new Set(['preview_doc', 'prepare_document'])

/** What a dead turn should have shown: some text, and maybe a decision. */
type ToolClosing = {
  content: string
  approval?: { question: string; options: string[] }
}

/**
 * Build the closing sentence a silent turn should have written.
 *
 * Measured over ten Layer 3 case-runs: `generate_document` ended the turn with
 * zero characters of content EVERY time it was the last tool, producing only
 * 225-530 characters of invisible reasoning. The old recovery was to nudge the
 * run with a synthetic "continue", which costs a second full inference and
 * re-injects the entire history to obtain a sentence the tool result already
 * contains.
 *
 * Returns null when the result cannot be read, which leaves the nudge path in
 * place as the fallback it always was.
 */
const buildClosingFromTool = (
  toolName: string,
  rawResult: unknown
): ToolClosing | null => {
  const closable = CLOSABLE_DOC_TOOLS.has(toolName)
  const needsApproval = APPROVAL_DOC_TOOLS.has(toolName)
  if (!closable && !needsApproval) return null

  let result: Record<string, unknown>
  try {
    result =
      typeof rawResult === 'string'
        ? JSON.parse(rawResult)
        : (rawResult as Record<string, unknown>)
  } catch {
    // Sessions written before tool results became JSON hold Python repr, which
    // JSON.parse cannot read. Nudging is the right answer there.
    return null
  }
  if (!result || typeof result !== 'object') return null

  if (needsApproval) return buildApprovalFromPreview(result)

  const message = typeof result.message === 'string' ? result.message.trim() : ''
  if (!message) return null

  // A generated document has a file to link. The link is what the user came
  // for, and the markdown form is what the panel and the chat both understand.
  const fileName = typeof result.file_name === 'string' ? result.file_name : ''
  const downloadUrl =
    typeof result.download_url === 'string' ? result.download_url : ''

  const summary = result.validation_summary as
    | { total_placeholders?: number; filled_from_data?: number }
    | undefined
  const filled = summary?.filled_from_data
  const total = summary?.total_placeholders
  const fillNote =
    typeof filled === 'number' && typeof total === 'number' && total > 0
      ? ` ${filled} of ${total} fields were filled from the register.`
      : ''

  // A finished document is the ONLY thing that may close a turn.
  //
  // The same tool also returns success:false with a readable message — "Choose
  // the resigning director for CITY HOLDINGS LIMITED before generating this
  // document." Rendering that as the final word would be worse than the blank
  // bubble it replaces: the user would be told to choose someone while the
  // picker card that does the choosing was never rendered, because the model
  // stopped before calling the lookup tool. That turn has work outstanding, so
  // it belongs to the nudge.
  if (result.success !== true || !fileName || !downloadUrl) return null

  return {
    content: `${message}.${fillNote}\n\n[${fileName}](${downloadUrl})`.replace(
      '..',
      '.'
    )
  }
}

/**
 * Turn a stalled preview into the preview plus the approval it owed.
 *
 * `preview_doc` returns `preview` as finished markdown — the field table the
 * user is meant to read — and `needs_approval: true`. Its `agent_instruction`
 * then spells out the exact question and the exact two options the model is
 * supposed to ask, which is what makes this reconstructable rather than
 * invented: nothing here is a guess about what the user should be asked.
 *
 * Returns null when the shape is not what it claims, so the nudge still covers
 * anything unrecognised.
 */
const buildApprovalFromPreview = (
  result: Record<string, unknown>
): ToolClosing | null => {
  const preview = typeof result.preview === 'string' ? result.preview.trim() : ''
  if (!preview || result.needs_approval !== true) return null

  const template =
    typeof result.template_name === 'string' ? result.template_name : ''
  const company =
    typeof result.company_name === 'string' ? result.company_name : ''
  if (!template || !company) return null

  // Same shortening the tool applies when it writes the question itself, so the
  // reconstructed card reads identically to the one the model should have sent.
  const short = template.replace(/\.docx$/i, '').replace(/_/g, ' ')
  const label = short.length > 40 ? `${short.slice(0, 37)}...` : short

  // `missing_fields` is what the REGISTER could not supply, so it still lists a
  // field that `custom_data` filled in from an earlier answer. Saying "2 fields
  // still need a value: meeting_date, new_director_identification_number" while
  // the table right above shows that NRC filled in is the kind of contradiction
  // a lawyer would have to stop and resolve. The tool writes the literal
  // "[TBD - needs input]" into `data` for anything genuinely unresolved, so the
  // values decide, not the list.
  const values = (result.data ?? {}) as Record<string, unknown>
  const isUnresolved = (field: string) => {
    const value = values[field]
    if (value === undefined || value === null) return true
    const text = String(value).trim()
    return text === '' || text.startsWith('[TBD')
  }
  const missing = (
    Array.isArray(result.missing_fields)
      ? (result.missing_fields as unknown[]).filter(
          (f): f is string => typeof f === 'string'
        )
      : []
  ).filter(isUnresolved)
  const coverage =
    typeof result.field_coverage === 'string' ? result.field_coverage : ''

  // "Every field is filled (83% coverage)" contradicts itself, and coverage is
  // not the same question as completeness: it measures how much the COMPANY
  // REGISTER supplied, so a document whose remaining values came from the
  // conversation is complete at 83%. Say what is true of the document, and only
  // mention the register when it is the reason something is outstanding.
  const note = missing.length
    ? `\n\n${missing.length} field${missing.length === 1 ? '' : 's'} still ` +
      `${missing.length === 1 ? 'needs' : 'need'} a value: ` +
      missing.slice(0, 6).join(', ') +
      (missing.length > 6 ? ', …' : '') +
      '.'
    : `\n\nEvery field has a value${
        coverage && coverage !== '100%'
          ? ` (${coverage} of them from the company register, the rest from this conversation)`
          : ''
      }.`

  return {
    content: `${preview}${note}`,
    approval: {
      question: `Generate ${label} for ${company} now?`,
      options: ['Yes, generate it', 'No, change the data first']
    }
  }
}

const useAIChatStreamHandler = () => {
  const setMessages = useStore((state) => state.setMessages)
  const { addMessage, focusChatInput } = useChatActions()
  const [agentId] = useQueryState('agent')
  const [teamId] = useQueryState('team')
  const [sessionId, setSessionId] = useQueryState('session')
  const selectedEndpoint = useStore((state) => state.selectedEndpoint)
  const authToken = useStore((state) => state.authToken)
  const mode = useStore((state) => state.mode)
  const setStreamingErrorMessage = useStore(
    (state) => state.setStreamingErrorMessage
  )
  const setIsStreaming = useStore((state) => state.setIsStreaming)
  const setSessionsData = useStore((state) => state.setSessionsData)
  const setAbortController = useStore((state) => state.setAbortController)
  const { streamResponse } = useAIResponseStream()

  const updateMessagesWithErrorState = useCallback(() => {
    setMessages((prevMessages) => {
      const newMessages = [...prevMessages]
      const lastMessage = newMessages[newMessages.length - 1]
      if (lastMessage && lastMessage.role === 'agent') {
        lastMessage.streamingError = true
      }
      return newMessages
    })
  }, [setMessages])

  /**
   * Processes a new tool call and adds it to the message
   * @param toolCall - The tool call to add
   * @param prevToolCalls - The previous tool calls array
   * @returns Updated tool calls array
   */
  const processToolCall = useCallback(
    (toolCall: ToolCall, prevToolCalls: ToolCall[] = []) => {
      const toolCallId =
        toolCall.tool_call_id || `${toolCall.tool_name}-${toolCall.created_at}`

      const existingToolCallIndex = prevToolCalls.findIndex(
        (tc) =>
          (tc.tool_call_id && tc.tool_call_id === toolCall.tool_call_id) ||
          (!tc.tool_call_id &&
            toolCall.tool_name &&
            toolCall.created_at &&
            `${tc.tool_name}-${tc.created_at}` === toolCallId)
      )
      if (existingToolCallIndex >= 0) {
        const updatedToolCalls = [...prevToolCalls]
        updatedToolCalls[existingToolCallIndex] = {
          ...updatedToolCalls[existingToolCallIndex],
          ...toolCall
        }
        return updatedToolCalls
      } else {
        return [...prevToolCalls, toolCall]
      }
    },
    []
  )

  /**
   * Processes tool calls from a chunk, handling both single tool object and tools array formats
   * @param chunk - The chunk containing tool call data
   * @param existingToolCalls - The existing tool calls array
   * @returns Updated tool calls array
   */
  const processChunkToolCalls = useCallback(
    (
      chunk: RunResponseContent | RunResponse,
      existingToolCalls: ToolCall[] = []
    ) => {
      let updatedToolCalls = [...existingToolCalls]
      // Handle new single tool object format
      if (chunk.tool) {
        updatedToolCalls = processToolCall(chunk.tool, updatedToolCalls)
      }
      // Handle legacy tools array format
      if (chunk.tools && chunk.tools.length > 0) {
        for (const toolCall of chunk.tools) {
          updatedToolCalls = processToolCall(toolCall, updatedToolCalls)
        }
      }

      return updatedToolCalls
    },
    [processToolCall]
  )

  // Per-stream scratch state. Refs (not closure locals) so that the chunk
  // handler can be shared between the initial run and a /continue resume.
  const lastContentRef = useRef('')
  const newSessionIdRef = useRef<string | null>(null)
  const sessionLabelRef = useRef('')

  // Typewriter smoothing: OpenRouter delivers tokens in multi-KB bursts with
  // second-long gaps, which reads as "not streaming". Received text goes into
  // streamTargetRef; a rAF loop reveals it into the store at a rate
  // proportional to the backlog, so bursts render as continuous typing.
  const streamTargetRef = useRef('')
  const revealRafRef = useRef<number | null>(null)
  // Runs already auto-nudged after a silent empty completion — one per run.
  const autoContinuedRunsRef = useRef<Set<string>>(new Set())
  // CONSECUTIVE silent stops nudged without the agent saying anything back.
  //
  // The per-run_id guard above cannot bound this on its own: every nudge starts
  // a NEW run with a NEW id, so a run that keeps stalling would be nudged
  // forever — and each nudge re-runs the document tools, which is how the same
  // document got generated three times in one session. Reset the moment the
  // agent produces real content.
  const consecutiveNudgesRef = useRef(0)
  // Tools seen during THIS stream.
  //
  // The silent-stop guard below used to read `chunk.tools` off the RunCompleted
  // event. RunPaused carries that key; RunCompleted does NOT carry it at all
  // (verified against the live stream: `'tools' in ev` is False, while
  // ToolCallStarted had already reported ask_questions and preview_doc). So
  // `didToolWork` was permanently false, the nudge never fired in the browser,
  // and neither did the out-of-retries message that shares the same guard — the
  // user was left with a blank bubble and no way to tell it from a finished
  // answer. Counting the ToolCallStarted events, the way tests/tracker_layer3.py
  // does, is what makes the guard see the tool work at all.
  const toolsThisRunRef = useRef(0)
  // The closing sentence for the most recent document tool, kept so a turn
  // that ends empty can be finished from the tool result rather than by paying
  // for a second inference. Reset with toolsThisRunRef at each stream start.
  const closingFromToolRef = useRef<ToolClosing | null>(null)

  const cancelReveal = useCallback(() => {
    if (revealRafRef.current != null) {
      cancelAnimationFrame(revealRafRef.current)
      revealRafRef.current = null
    }
  }, [])

  const startReveal = useCallback(() => {
    if (revealRafRef.current != null) return
    const tick = () => {
      revealRafRef.current = null
      let caughtUp = false
      setMessages((prevMessages) => {
        const newMessages = [...prevMessages]
        const lastMessage = newMessages[newMessages.length - 1]
        if (!lastMessage || lastMessage.role !== 'agent') {
          caughtUp = true
          return prevMessages
        }
        const target = streamTargetRef.current
        const current = lastMessage.content ?? ''
        if (current.length >= target.length) {
          caughtUp = true
          return prevMessages
        }
        const backlog = target.length - current.length
        // Typing pace, not instant catch-up: ~1-2 chars/frame for small
        // backlogs so a burst keeps typing across the gap until the next one,
        // ramping up (capped) so long answers never fall minutes behind.
        const step = Math.min(24, Math.max(1, Math.ceil(backlog / 40)))
        newMessages[newMessages.length - 1] = {
          ...lastMessage,
          content: target.slice(0, current.length + step)
        }
        return newMessages
      })
      if (!caughtUp) revealRafRef.current = requestAnimationFrame(tick)
    }
    revealRafRef.current = requestAnimationFrame(tick)
  }, [setMessages])

  /** Flush everything received so far straight into the message (end/error). */
  const flushReveal = useCallback(() => {
    cancelReveal()
    const target = streamTargetRef.current
    if (!target) return
    setMessages((prevMessages) => {
      const newMessages = [...prevMessages]
      const lastMessage = newMessages[newMessages.length - 1]
      if (!lastMessage || lastMessage.role !== 'agent') return prevMessages
      if ((lastMessage.content ?? '').length >= target.length)
        return prevMessages
      newMessages[newMessages.length - 1] = {
        ...lastMessage,
        content: target
      }
      return newMessages
    })
  }, [cancelReveal, setMessages])

  /**
   * RunPaused — the agent hit a tool declared with requires_user_input=True.
   * Two HITL tool families pause: the `choose_*` people pickers and the
   * structured `ask_user` question tool. Attach one request per paused tool to
   * the in-flight agent message so the cards render inline in the transcript.
   */
  const handleRunPaused = useCallback(
    (chunk: RunResponse) => {
      const paused = (chunk.tools ?? []).filter(
        (tool) => tool.requires_user_input === true
      )
      const pausedPickers = paused.filter((tool) => isPickerTool(tool.tool_name))
      const pausedAsks = paused.filter((tool) => isAskUserTool(tool.tool_name))
      if (pausedPickers.length === 0 && pausedAsks.length === 0) return

      setMessages((prevMessages) => {
        const newMessages = [...prevMessages]
        const lastMessage = newMessages[newMessages.length - 1]
        if (!lastMessage || lastMessage.role !== 'agent') return prevMessages

        const priorToolCalls = lastMessage.tool_calls ?? []
        const ctx = {
          runId: chunk.run_id ?? '',
          agentId: chunk.agent_id,
          sessionId: chunk.session_id
        }

        const pickerRequests: PickerRequest[] = [
          ...(lastMessage.picker_requests ?? [])
        ]
        for (const tool of pausedPickers) {
          if (pickerRequests.some((r) => r.tool_call_id === tool.tool_call_id))
            continue
          pickerRequests.push(
            buildPickerRequest(tool, { ...ctx, priorToolCalls })
          )
        }

        const askRequests: AskUserRequest[] = [
          ...(lastMessage.ask_user_requests ?? [])
        ]
        for (const tool of pausedAsks) {
          if (askRequests.some((r) => r.tool_call_id === tool.tool_call_id))
            continue
          // Bad/empty questions_json → null; nothing renders, run stays paused.
          const built = buildAskUserRequest(tool, ctx)
          if (built) askRequests.push(built)
        }

        newMessages[newMessages.length - 1] = {
          ...lastMessage,
          picker_requests: pickerRequests.length ? pickerRequests : undefined,
          ask_user_requests: askRequests.length ? askRequests : undefined,
          tool_calls: processChunkToolCalls(chunk, lastMessage.tool_calls)
        }
        return newMessages
      })
    },
    [setMessages, processChunkToolCalls]
  )

  const handleChunk = useCallback(
    (chunk: RunResponse) => {
      if (
        chunk.event === RunEvent.RunStarted ||
        chunk.event === RunEvent.TeamRunStarted ||
        chunk.event === RunEvent.ReasoningStarted ||
        chunk.event === RunEvent.TeamReasoningStarted
      ) {
        newSessionIdRef.current = (chunk.session_id as string) ?? null
        setSessionId((chunk.session_id as string) ?? null)
        if (chunk.session_id) {
          const sessionData = {
            session_id: chunk.session_id as string,
            session_name: sessionLabelRef.current,
            created_at: chunk.created_at
          }
          setSessionsData((prevSessionsData) => {
            const sessionExists = prevSessionsData?.some(
              (session) => session.session_id === chunk.session_id
            )
            if (sessionExists) {
              return prevSessionsData
            }
            return [sessionData, ...(prevSessionsData ?? [])]
          })
        }
      } else if (chunk.event === RunEvent.RunPaused) {
        handleRunPaused(chunk)
      } else if (chunk.event === RunEvent.RunContinued) {
        // Resume acknowledged; content for the resumed run streams in next.
      } else if (
        chunk.event === RunEvent.ToolCallStarted ||
        chunk.event === RunEvent.TeamToolCallStarted ||
        chunk.event === RunEvent.ToolCallCompleted ||
        chunk.event === RunEvent.TeamToolCallCompleted
      ) {
        if (
          chunk.event === RunEvent.ToolCallStarted ||
          chunk.event === RunEvent.TeamToolCallStarted
        ) {
          toolsThisRunRef.current += 1
        } else {
          // Completed: the result is here, so the closing sentence can be
          // written now, while `chunk.tool` still carries it. RunCompleted
          // carries no tools at all.
          const finished = chunk.tool
          if (finished?.tool_name) {
            const closing = buildClosingFromTool(
              finished.tool_name,
              finished.result
            )
            if (closing?.content) closingFromToolRef.current = closing
          }
        }
        setMessages((prevMessages) => {
          const newMessages = [...prevMessages]
          const lastMessage = newMessages[newMessages.length - 1]
          if (lastMessage && lastMessage.role === 'agent') {
            lastMessage.tool_calls = processChunkToolCalls(
              chunk,
              lastMessage.tool_calls
            )
          }
          return newMessages
        })
      } else if (
        chunk.event === RunEvent.RunContent ||
        chunk.event === RunEvent.TeamRunContent
      ) {
        // Capture the model's reasoning. gemini-3.6-flash streams it on
        // RunContent as `reasoning_content`, and a turn can produce reasoning
        // and NO content at all — which rendered as an empty bubble that looked
        // exactly like a stall. Stored here, shown collapsed by the message.
        if (typeof chunk.reasoning_content === 'string' && chunk.reasoning_content) {
          const reasoning = chunk.reasoning_content
          setMessages((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last && last.role === 'agent') {
              next[next.length - 1] = { ...last, reasoning_content: reasoning }
            }
            return next
          })
        }

        // Agno narrates its own pause ("I have tools to execute, but I need
        // user input.") before emitting RunPaused. That is framework plumbing
        // talking about itself — the picker or question card that follows says
        // everything the user needs. Dropped here rather than disabled inside
        // agno, which would mean touching the fragile HITL resume path.
        if (
          typeof chunk.content === 'string' &&
          AGNO_PAUSE_BOILERPLATE.test(chunk.content.trim())
        ) {
          return
        }

        // Junk-only content gets the same treatment, but ONLY while the
        // message is still empty — that is the `]}` case, a whole answer made
        // of a truncated payload's tail. Mid-answer a lone `{` or `"` is an
        // ordinary streaming delta of real prose, so once anything real has
        // landed in streamTargetRef every delta is appended unfiltered.
        if (
          !isRealContent(streamTargetRef.current) &&
          typeof chunk.content === 'string' &&
          !isRealContent(chunk.content)
        ) {
          return
        }
        setMessages((prevMessages) => {
          const newMessages = [...prevMessages]
          const lastMessage = newMessages[newMessages.length - 1]
          if (
            lastMessage &&
            lastMessage.role === 'agent' &&
            typeof chunk.content === 'string'
          ) {
            const uniqueContent = chunk.content.replace(
              lastContentRef.current,
              ''
            )
            // Buffered, not appended: the rAF reveal loop types it out.
            streamTargetRef.current += uniqueContent
            lastContentRef.current = chunk.content

            // Handle tool calls streaming
            lastMessage.tool_calls = processChunkToolCalls(
              chunk,
              lastMessage.tool_calls
            )
            if (chunk.extra_data?.reasoning_steps) {
              lastMessage.extra_data = {
                ...lastMessage.extra_data,
                reasoning_steps: chunk.extra_data.reasoning_steps
              }
            }

            if (chunk.extra_data?.references) {
              lastMessage.extra_data = {
                ...lastMessage.extra_data,
                references: chunk.extra_data.references
              }
            }

            lastMessage.created_at = chunk.created_at ?? lastMessage.created_at
            if (chunk.images) {
              lastMessage.images = chunk.images
            }
            if (chunk.videos) {
              lastMessage.videos = chunk.videos
            }
            if (chunk.audio) {
              lastMessage.audio = chunk.audio
            }
          } else if (
            lastMessage &&
            lastMessage.role === 'agent' &&
            typeof chunk?.content !== 'string' &&
            chunk.content !== null
          ) {
            const jsonBlock = getJsonMarkdown(chunk?.content)

            streamTargetRef.current += jsonBlock
            lastContentRef.current = jsonBlock
          } else if (
            chunk.response_audio?.transcript &&
            typeof chunk.response_audio?.transcript === 'string'
          ) {
            const transcript = chunk.response_audio.transcript
            lastMessage.response_audio = {
              ...lastMessage.response_audio,
              transcript:
                lastMessage.response_audio?.transcript + transcript
            }
          }
          return newMessages
        })
        startReveal()
      } else if (
        chunk.event === RunEvent.ReasoningStep ||
        chunk.event === RunEvent.TeamReasoningStep
      ) {
        setMessages((prevMessages) => {
          const newMessages = [...prevMessages]
          const lastMessage = newMessages[newMessages.length - 1]
          if (lastMessage && lastMessage.role === 'agent') {
            const existingSteps = lastMessage.extra_data?.reasoning_steps ?? []
            const incomingSteps = chunk.extra_data?.reasoning_steps ?? []
            lastMessage.extra_data = {
              ...lastMessage.extra_data,
              reasoning_steps: [...existingSteps, ...incomingSteps]
            }
          }
          return newMessages
        })
      } else if (
        chunk.event === RunEvent.ReasoningCompleted ||
        chunk.event === RunEvent.TeamReasoningCompleted
      ) {
        setMessages((prevMessages) => {
          const newMessages = [...prevMessages]
          const lastMessage = newMessages[newMessages.length - 1]
          if (lastMessage && lastMessage.role === 'agent') {
            if (chunk.extra_data?.reasoning_steps) {
              lastMessage.extra_data = {
                ...lastMessage.extra_data,
                reasoning_steps: chunk.extra_data.reasoning_steps
              }
            }
          }
          return newMessages
        })
      } else if (
        chunk.event === RunEvent.RunError ||
        chunk.event === RunEvent.TeamRunError ||
        chunk.event === RunEvent.TeamRunCancelled
      ) {
        flushReveal()
        updateMessagesWithErrorState()
        const errorContent =
          (chunk.content as string) ||
          (chunk.event === RunEvent.TeamRunCancelled
            ? 'Run cancelled'
            : 'Error during run')
        setStreamingErrorMessage(errorContent)
        if (newSessionIdRef.current) {
          const staleId = newSessionIdRef.current
          setSessionsData(
            (prevSessionsData) =>
              prevSessionsData?.filter(
                (session) => session.session_id !== staleId
              ) ?? null
          )
        }
      } else if (
        chunk.event === RunEvent.UpdatingMemory ||
        chunk.event === RunEvent.TeamMemoryUpdateStarted ||
        chunk.event === RunEvent.TeamMemoryUpdateCompleted
      ) {
        // No-op for now; could surface a lightweight UI indicator in the future
      } else if (
        chunk.event === RunEvent.RunCompleted ||
        chunk.event === RunEvent.TeamRunCompleted
      ) {
        // Final event carries the authoritative full content — stop the
        // typewriter and let the replace below win.
        cancelReveal()
        if (typeof chunk.content === 'string')
          streamTargetRef.current = chunk.content

        // Silent-stop guard: large-context runs sometimes finish with tool
        // work done but an EMPTY final message (the model just stops). If
        // nothing is pending for the user, nudge once per run with the
        // "continue" a human would type.
        const finishedEmpty =
          typeof chunk.content === 'string' && chunk.content.trim() === ''
        // Counted from ToolCallStarted, NOT read off `chunk.tools` — see
        // toolsThisRunRef: RunCompleted does not carry a `tools` key.
        const didToolWork =
          toolsThisRunRef.current > 0 || (chunk.tools?.length ?? 0) > 0
        const waitingOnUser = (chunk.tools ?? []).some(
          (t) => t.requires_user_input === true
        )
        // Real output means the agent is talking again — forget the run of
        // stalls. A `]}` tail is not the agent talking: it must leave the
        // counter alone so the retry budget survives.
        if (isRealContent(chunk.content)) {
          consecutiveNudgesRef.current = 0
        }

        // The turn ended empty but a document tool already said, in English,
        // what happened. Write that instead of nudging: the nudge costs a whole
        // second inference with the full history re-injected, to recover a
        // sentence that is sitting in the tool result.
        const closeFromTool =
          finishedEmpty && didToolWork && !waitingOnUser
            ? closingFromToolRef.current
            : null
        if (closeFromTool) {
          consecutiveNudgesRef.current = 0
        }

        if (
          !closeFromTool &&
          finishedEmpty &&
          didToolWork &&
          !waitingOnUser &&
          chunk.run_id &&
          !autoContinuedRunsRef.current.has(chunk.run_id) &&
          consecutiveNudgesRef.current < MAX_CONSECUTIVE_NUDGES
        ) {
          autoContinuedRunsRef.current.add(chunk.run_id)
          consecutiveNudgesRef.current += 1
          setTimeout(() => {
            useStore.getState().setPendingMessage('continue')
          }, 400)
        } else if (
          !closeFromTool &&
          finishedEmpty &&
          didToolWork &&
          !waitingOnUser &&
          consecutiveNudgesRef.current >= MAX_CONSECUTIVE_NUDGES
        ) {
          // Out of retries. Say so, rather than leaving a blank bubble that is
          // indistinguishable from a finished answer.
          consecutiveNudgesRef.current = 0
          setStreamingErrorMessage(
            'The assistant stopped without replying. Send "continue" to resume, ' +
              'or rephrase the request.'
          )
        }
        setMessages((prevMessages) => {
          const newMessages = prevMessages.map((message, index) => {
            if (index === prevMessages.length - 1 && message.role === 'agent') {
              let updatedContent: string
              if (closeFromTool) {
                // The model wrote nothing; the tool result speaks for it.
                updatedContent = closeFromTool.content
              } else if (typeof chunk.content === 'string') {
                updatedContent = chunk.content
              } else {
                try {
                  updatedContent = JSON.stringify(chunk.content)
                } catch {
                  updatedContent = 'Error parsing response'
                }
              }
              return {
                ...message,
                content: updatedContent,
                // Only set when the turn died owing a decision. `null` clears a
                // stale card if this message is re-rendered after a real reply.
                pending_approval: closeFromTool?.approval ?? null,
                tool_calls: processChunkToolCalls(chunk, message.tool_calls),
                images: chunk.images ?? message.images,
                videos: chunk.videos ?? message.videos,
                response_audio: chunk.response_audio,
                created_at: chunk.created_at ?? message.created_at,
                extra_data: {
                  reasoning_steps:
                    chunk.extra_data?.reasoning_steps ??
                    message.extra_data?.reasoning_steps,
                  references:
                    chunk.extra_data?.references ??
                    message.extra_data?.references
                }
              }
            }
            return message
          })
          return newMessages
        })
      }
    },
    [
      handleRunPaused,
      processChunkToolCalls,
      setMessages,
      setSessionId,
      setSessionsData,
      setStreamingErrorMessage,
      updateMessagesWithErrorState,
      startReveal,
      cancelReveal,
      flushReveal
    ]
  )

  /**
   * Marks a picker card resolved wherever it lives in the transcript, so it
   * stays disabled for the rest of the session — including after the resumed
   * response streams in.
   */
  const setPickerStatus = useCallback(
    (
      toolCallId: string,
      status: PickerRequest['status'],
      answerSummary?: string
    ) => {
      setMessages((prevMessages) =>
        prevMessages.map((message) => {
          if (!message.picker_requests?.length) return message
          if (!message.picker_requests.some((r) => r.tool_call_id === toolCallId))
            return message
          return {
            ...message,
            picker_requests: message.picker_requests.map((request) =>
              request.tool_call_id === toolCallId
                ? { ...request, status, answer_summary: answerSummary }
                : request
            )
          }
        })
      )
    },
    [setMessages]
  )

  /** As setPickerStatus, for `ask_user` cards. */
  const setAskUserStatus = useCallback(
    (
      toolCallId: string,
      status: AskUserRequest['status'],
      answerSummary?: string
    ) => {
      setMessages((prevMessages) =>
        prevMessages.map((message) => {
          if (!message.ask_user_requests?.length) return message
          if (
            !message.ask_user_requests.some((r) => r.tool_call_id === toolCallId)
          )
            return message
          return {
            ...message,
            ask_user_requests: message.ask_user_requests.map((request) =>
              request.tool_call_id === toolCallId
                ? { ...request, status, answer_summary: answerSummary }
                : request
            )
          }
        })
      )
    },
    [setMessages]
  )

  /**
   * Streams a paused run's /continue call. Both HITL families (picker and
   * ask_user) share this: only the resume-request body and the per-card status
   * transitions differ, so those come in as callbacks.
   *
   * POST {endpoint}/agents/{agent_id}/runs/{run_id}/continue as multipart form,
   * same run_id so history stays intact. The answered card is locked first (the
   * run can only be continued once); the resumed response streams into a NEW
   * agent message so the answered card stays visible above it. On failure the
   * card is returned to `pending` so the user can retry.
   */
  const resumeRun = useCallback(
    async (params: {
      runId: string
      agentId?: string
      sessionId?: string
      toolCallId: string
      summary: string
      buildRequest: (
        endpointUrl: string,
        options: {
          authToken?: string
          sessionId?: string | null
          userId?: string | null
        }
      ) => { url: string; headers: Record<string, string>; formData: FormData }
      markAnswered: (summary: string) => void
      markPending: () => void
    }) => {
      if (!params.runId) {
        toast.error('Cannot resume: this request has no run id.')
        return
      }
      if (!(params.agentId ?? agentId)) {
        toast.error('Cannot resume: no agent selected.')
        return
      }

      // Disable the card immediately — the run can only be continued once.
      params.markAnswered(params.summary)
      setIsStreaming(true)

      const endpointUrl = constructEndpointUrl(selectedEndpoint)
      const { url, headers, formData } = params.buildRequest(endpointUrl, {
        authToken,
        sessionId: sessionId ?? params.sessionId ?? '',
        userId: getLocalUserId()
      })

      addMessage({
        role: 'agent',
        content: '',
        tool_calls: [],
        streamingError: false,
        created_at: Math.floor(Date.now() / 1000)
      })

      lastContentRef.current = ''
      streamTargetRef.current = ''
      toolsThisRunRef.current = 0
      closingFromToolRef.current = null
      cancelReveal()
      const controller = new AbortController()
      setAbortController(controller)

      try {
        await streamResponse({
          apiUrl: url,
          headers,
          requestBody: formData,
          signal: controller.signal,
          onChunk: handleChunk,
          onError: (error) => {
            // The resume never landed — let the user try again.
            params.markPending()
            updateMessagesWithErrorState()
            setStreamingErrorMessage(error.message)
            toast.error(`Could not resume the run: ${error.message}`)
          },
          onComplete: () => {}
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        params.markPending()
        updateMessagesWithErrorState()
        setStreamingErrorMessage(message)
        toast.error(`Could not resume the run: ${message}`)
      } finally {
        focusChatInput()
        setIsStreaming(false)
        setAbortController(null)
      }
    },
    [
      addMessage,
      agentId,
      authToken,
      focusChatInput,
      handleChunk,
      selectedEndpoint,
      sessionId,
      setAbortController,
      setIsStreaming,
      setStreamingErrorMessage,
      streamResponse,
      updateMessagesWithErrorState
    ]
  )

  /** Resumes a paused run with the user's people-picker selection. */
  const continueRun = useCallback(
    (
      request: PickerRequest,
      selection: PickerSelectionEntry | PickerSelectionEntry[]
    ) =>
      resumeRun({
        runId: request.run_id,
        agentId: request.agent_id,
        sessionId: request.session_id,
        toolCallId: request.tool_call_id,
        summary: summariseSelection(selection),
        buildRequest: (endpointUrl, options) =>
          buildContinueRunRequest(
            endpointUrl,
            { ...request, agent_id: request.agent_id ?? agentId ?? undefined },
            selection,
            options
          ),
        markAnswered: (summary) =>
          setPickerStatus(request.tool_call_id, 'answered', summary),
        markPending: () => setPickerStatus(request.tool_call_id, 'pending')
      }),
    [resumeRun, agentId, setPickerStatus]
  )

  /** Resumes a paused run with the user's `ask_user` answers. */
  const continueRunAskUser = useCallback(
    (request: AskUserRequest, answers: AskUserAnswerMap) =>
      resumeRun({
        runId: request.run_id,
        agentId: request.agent_id,
        sessionId: request.session_id,
        toolCallId: request.tool_call_id,
        summary: summariseAnswers(request.questions, answers),
        buildRequest: (endpointUrl, options) =>
          buildAskUserContinueRequest(
            endpointUrl,
            { ...request, agent_id: request.agent_id ?? agentId ?? undefined },
            answers,
            options
          ),
        markAnswered: (summary) =>
          setAskUserStatus(request.tool_call_id, 'answered', summary),
        markPending: () => setAskUserStatus(request.tool_call_id, 'pending')
      }),
    [resumeRun, agentId, setAskUserStatus]
  )

  const handleStreamResponse = useCallback(
    async (input: string | FormData) => {
      setIsStreaming(true)

      const formData = input instanceof FormData ? input : new FormData()
      if (typeof input === 'string') {
        formData.append('message', input)
      }

      setMessages((prevMessages) => {
        if (prevMessages.length >= 2) {
          const lastMessage = prevMessages[prevMessages.length - 1]
          const secondLastMessage = prevMessages[prevMessages.length - 2]
          if (
            lastMessage.role === 'agent' &&
            lastMessage.streamingError &&
            secondLastMessage.role === 'user'
          ) {
            return prevMessages.slice(0, -2)
          }
        }
        return prevMessages
      })

      const attachmentsStr = formData.get('attachments') as string | null
      const attachments = attachmentsStr ? JSON.parse(attachmentsStr) : undefined

      addMessage({
        role: 'user',
        content: formData.get('message') as string,
        created_at: Math.floor(Date.now() / 1000),
        attachments
      })

      addMessage({
        role: 'agent',
        content: '',
        tool_calls: [],
        streamingError: false,
        created_at: Math.floor(Date.now() / 1000) + 1
      })

      lastContentRef.current = ''
      streamTargetRef.current = ''
      toolsThisRunRef.current = 0
      closingFromToolRef.current = null
      cancelReveal()
      newSessionIdRef.current = sessionId
      sessionLabelRef.current = (formData.get('message') as string) ?? ''
      try {
        const endpointUrl = constructEndpointUrl(selectedEndpoint)

        let RunUrl: string | null = null

        if (mode === 'team' && teamId) {
          RunUrl = APIRoutes.TeamRun(endpointUrl, teamId)
        } else if (mode === 'agent' && agentId) {
          RunUrl = APIRoutes.AgentRun(endpointUrl).replace(
            '{agent_id}',
            agentId
          )
        }

        if (!RunUrl) {
          updateMessagesWithErrorState()
          setStreamingErrorMessage('Please select an agent or team first.')
          setIsStreaming(false)
          return
        }

        formData.append('stream', 'true')
        formData.append('session_id', sessionId ?? '')

        // Tag run with current user so sessions are filtered per-user
        if (typeof window !== 'undefined') {
          try {
            const u = JSON.parse(localStorage.getItem('ls_user') || 'null')
            if (u?.id != null) formData.append('user_id', String(u.id))
          } catch {}
        }

        // Create abort controller for cancellation
        const controller = new AbortController()
        setAbortController(controller)

        // Create headers with auth token if available.
        //
        // `authToken` from the store is a playground leftover and is '' on
        // every page load (it is not in the store's partialize), so the real
        // JWT has to come from localStorage — the same place lib/api-client.ts
        // reads it. This POST is the chat itself; without the header it 401s
        // now that /agents is behind the JWT.
        const headers: Record<string, string> = {}
        let bearer = authToken
        if (!bearer) {
          try {
            bearer = localStorage.getItem('ls_token') || ''
          } catch {
            bearer = ''
          }
        }
        if (bearer) {
          headers['Authorization'] = `Bearer ${bearer}`
        }

        await streamResponse({
          apiUrl: RunUrl,
          headers,
          requestBody: formData,
          signal: controller.signal,
          onChunk: handleChunk,
          onError: (error) => {
            updateMessagesWithErrorState()
            setStreamingErrorMessage(error.message)
            const staleId = newSessionIdRef.current
            if (staleId) {
              setSessionsData(
                (prevSessionsData) =>
                  prevSessionsData?.filter(
                    (session) => session.session_id !== staleId
                  ) ?? null
              )
            }
          },
          onComplete: () => {}
        })
      } catch (error) {
        updateMessagesWithErrorState()
        setStreamingErrorMessage(
          error instanceof Error ? error.message : String(error)
        )
        const staleId = newSessionIdRef.current
        if (staleId) {
          setSessionsData(
            (prevSessionsData) =>
              prevSessionsData?.filter(
                (session) => session.session_id !== staleId
              ) ?? null
          )
        }
      } finally {
        focusChatInput()
        setIsStreaming(false)
        setAbortController(null)
      }
    },
    [
      setMessages,
      addMessage,
      updateMessagesWithErrorState,
      selectedEndpoint,
      authToken,
      streamResponse,
      agentId,
      teamId,
      mode,
      setStreamingErrorMessage,
      setIsStreaming,
      setAbortController,
      focusChatInput,
      setSessionsData,
      sessionId,
      handleChunk
    ]
  )

  const abortController = useStore((state) => state.abortController)

  const cancelStream = useCallback(() => {
    if (abortController) {
      abortController.abort()
      setAbortController(null)
      setIsStreaming(false)
      setStreamingErrorMessage('Request cancelled')
    }
  }, [abortController, setAbortController, setIsStreaming, setStreamingErrorMessage])

  return { handleStreamResponse, cancelStream, continueRun, continueRunAskUser }
}

export default useAIChatStreamHandler
