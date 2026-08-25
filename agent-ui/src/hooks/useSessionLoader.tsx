import { useCallback, useState } from 'react'
import {
  getSessionAPI,
  getAllSessionsAPI,
  isAgnoPauseBoilerplate
} from '@/api/os'
import { useStore } from '../store'
import { toast } from 'sonner'
import {
  ApiError,
  ChatMessage,
  MessageTokenUsage,
  RunMetrics,
  SessionEntry,
  SessionRun,
  ToolCall,
  ReasoningMessage,
  PickerRequest,
  AskUserRequest
} from '@/types/os'
import { getJsonMarkdown } from '@/lib/utils'
import {
  buildPickerRequest,
  isPickerTool
} from '@/components/chat/pickerPayload'
import {
  buildAskUserRequest,
  isAskUserTool,
  resolveAskUserAnswers,
  summariseAnswers,
  summariseAnswersFromResult
} from '@/components/chat/askUserPayload'

/**
 * Rebuilds picker cards from a past run.
 *
 * These are ALWAYS read-only. A run rehydrated from history is either already
 * answered, or still paused but owned by a stream this tab no longer holds —
 * in both cases resuming from here would be wrong, so the card renders in a
 * closed state and the user is told to ask again in chat.
 */
const historicalPickerRequests = (
  toolCalls: ToolCall[],
  context: { runId: string; agentId?: string; sessionId?: string }
): PickerRequest[] =>
  toolCalls
    .filter((toolCall) => isPickerTool(toolCall.tool_name))
    .filter(
      (toolCall) =>
        toolCall.requires_user_input === true || toolCall.answered === true
    )
    .map((toolCall) => {
      const request = buildPickerRequest(toolCall, {
        ...context,
        priorToolCalls: toolCalls
      })

      let answerSummary: string | undefined
      if (toolCall.result) {
        try {
          const parsed = JSON.parse(toolCall.result)
          if (Array.isArray(parsed?.selected)) {
            answerSummary = parsed.selected
              .map((entry: { name?: string }) => entry?.name ?? '')
              .filter(Boolean)
              .join(', ')
          }
        } catch (error) {
          console.warn('Could not parse picker tool result', error)
        }
      }

      // Same policy as ask_questions: an ANSWERED pause locks with its summary;
      // a genuinely outstanding one stays LIVE — the run persists server-side,
      // so resuming from a reloaded session works (proven by ask_questions).
      if (toolCall.answered === true || answerSummary) {
        return {
          ...request,
          status: 'answered' as const,
          answer_summary: answerSummary
        }
      }
      return request
    })

/**
 * Rebuilds `ask_user` question cards from a past run.
 *
 * History differs from the live RunPaused chunk: an answered tool comes back
 * with `requires_user_input=false` / `answered=true` and its answers stored in
 * the `answers` entry of `user_input_schema` (the `result` field is null). So
 * we match on the tool NAME, not the flag, and read answers from the schema.
 *
 *   - Answered  → locked card with the green "Answered" banner + summary.
 *   - Still paused → interactive card; the run persists server-side, so resume
 *     still works after reload using the run_id carried in from history.
 *
 * Unusable (bad JSON) questions are dropped rather than rendered broken.
 */
const historicalAskUserRequests = (
  toolCalls: ToolCall[],
  context: { runId: string; agentId?: string; sessionId?: string }
): AskUserRequest[] =>
  toolCalls
    .filter((toolCall) => isAskUserTool(toolCall.tool_name))
    .map((toolCall): AskUserRequest | null => {
      const request = buildAskUserRequest(toolCall, context)
      if (!request) return null

      const answers = resolveAskUserAnswers(
        toolCall.user_input_schema,
        toolCall.tool_args
      )
      const answered = toolCall.answered === true || answers !== null
      if (!answered) {
        // Genuine outstanding pause — leave it live so it can be resumed.
        return request
      }

      return {
        ...request,
        status: 'answered',
        answer_summary:
          (answers && summariseAnswers(request.questions, answers)) ||
          summariseAnswersFromResult(request.questions, toolCall.result)
      }
    })
    .filter((request): request is AskUserRequest => request !== null)

interface LoaderArgs {
  entityType: 'agent' | 'team' | null
  agentId?: string | null
  teamId?: string | null
  dbId: string | null
}

/**
 * Outcome of one `getSessions` call.
 *
 * `empty` and `error` used to be indistinguishable — both arrived as an empty
 * array, so a 401 painted the same "no chats yet" state as a brand-new
 * account. They are now separate states, and `skipped` is a third: the effect
 * fired before the endpoint / agent id was known, so nothing was asked at all
 * and the previous list should stand.
 */
export type SessionsLoadResult =
  | { status: 'ok'; sessions: SessionEntry[] }
  | { status: 'empty'; sessions: [] }
  | { status: 'error'; sessions: []; error: ApiError }
  | { status: 'skipped' }

/**
 * Timestamps arrive in two shapes from the SAME response: a run's `created_at`
 * is an ISO-8601 string (`"2026-08-24T13:00:29Z"`), a tool call's is epoch
 * seconds (`1787578823`). Both measured live. `ChatMessage.created_at` is
 * epoch seconds, so everything is normalised here rather than at each render
 * site. An unparseable value falls back to "now" — a message with no timestamp
 * at all would render as 1970.
 */
const toEpochSeconds = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Agno sends seconds; tolerate milliseconds so a future change is not a
    // silent jump to the year 58000.
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value)
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  }
  return Math.floor(Date.now() / 1000)
}

/**
 * Per-message token figures, from the run's own `metrics`.
 *
 * Measured keys on the live endpoint: `input_tokens`, `output_tokens`,
 * `total_tokens`, `cost`, `cache_read_tokens`, `reasoning_tokens`,
 * `time_to_first_token`, `duration`. Nothing else is assumed to exist.
 *
 * ★ Token counts live on the RUN, never on the individual tool call — every
 * tool entry observed came back with `metrics: {}` or `metrics: null`, even on
 * a fully-measured run. Returns `null` when the run reported nothing, so a
 * renderer can tell "no data" from "zero tokens".
 */
const tokenUsageFromRun = (
  metrics: RunMetrics | null | undefined
): MessageTokenUsage | null => {
  if (!metrics || typeof metrics !== 'object') return null

  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

  const input = num(metrics.input_tokens)
  const output = num(metrics.output_tokens)
  const reported = num(metrics.total_tokens)
  const total =
    reported ??
    (input === null && output === null ? null : (input ?? 0) + (output ?? 0))
  const cost = num(metrics.cost)
  const duration = num(metrics.duration)

  if (
    input === null &&
    output === null &&
    total === null &&
    cost === null &&
    duration === null
  ) {
    return null
  }
  return { input, output, total, cost, duration }
}

const useSessionLoader = () => {
  const setMessages = useStore((state) => state.setMessages)
  const selectedEndpoint = useStore((state) => state.selectedEndpoint)
  const authToken = useStore((state) => state.authToken)
  const setIsSessionsLoading = useStore((state) => state.setIsSessionsLoading)
  const setSessionsData = useStore((state) => state.setSessionsData)

  /**
   * Why hook state and not the zustand store: the store is owned by another
   * file in this pass and cannot gain a field. This is deliberately equivalent
   * for the one consumer that matters — `Sessions.tsx` is the only component
   * that calls `getSessions`, and it holds this same hook instance, so it sees
   * every transition. `SessionItem.tsx` mounts its own instance and only uses
   * `getSession`; its `sessionsError` stays `null`, which is correct — it
   * never loads the list.
   */
  const [sessionsError, setSessionsError] = useState<ApiError | null>(null)
  const clearSessionsError = useCallback(() => setSessionsError(null), [])

  const getSessions = useCallback(
    async ({
      entityType,
      agentId,
      teamId,
      dbId
    }: LoaderArgs): Promise<SessionsLoadResult> => {
      const selectedId = entityType === 'agent' ? agentId : teamId
      if (!selectedEndpoint || !entityType || !selectedId || !dbId) {
        return { status: 'skipped' }
      }

      try {
        setIsSessionsLoading(true)

        let userId: string | null = null
        if (typeof window !== 'undefined') {
          try {
            const u = JSON.parse(localStorage.getItem('ls_user') || 'null')
            if (u?.id != null) userId = String(u.id)
          } catch {}
        }

        const result = await getAllSessionsAPI(
          selectedEndpoint,
          entityType,
          selectedId,
          dbId,
          authToken,
          userId
        )

        if (!result.ok) {
          // The list is emptied because we no longer know what it holds — but
          // the error is recorded alongside it, so the sidebar can say WHY
          // instead of claiming the account has no chats.
          setSessionsError(result.error)
          setSessionsData([])
          toast.error(result.error.message)
          return { status: 'error', sessions: [], error: result.error }
        }

        setSessionsError(null)
        setSessionsData(result.data)
        return result.data.length === 0
          ? { status: 'empty', sessions: [] }
          : { status: 'ok', sessions: result.data }
      } finally {
        setIsSessionsLoading(false)
      }
    },
    [selectedEndpoint, authToken, setSessionsData, setIsSessionsLoading]
  )

  const getSession = useCallback(
    async (
      { entityType, agentId, teamId, dbId }: LoaderArgs,
      sessionId: string
    ) => {
      const selectedId = entityType === 'agent' ? agentId : teamId
      if (
        !selectedEndpoint ||
        !sessionId ||
        !entityType ||
        !selectedId ||
        !dbId
      )
        return

      try {
        const response: unknown = await getSessionAPI(
          selectedEndpoint,
          entityType,
          sessionId,
          dbId,
          authToken
        )
        if (response) {
          if (Array.isArray(response)) {
            const runs = response as SessionRun[]
            const messagesFor = runs.flatMap((run) => {
              const filteredMessages: ChatMessage[] = []
              const runCreatedAt = toEpochSeconds(run?.created_at)
              const tokenUsage = tokenUsageFromRun(run?.metrics)

              if (run) {
                filteredMessages.push({
                  role: 'user',
                  content: run.run_input ?? '',
                  created_at: runCreatedAt,
                  run_id: run.run_id
                })
              }

              if (run) {
                const toolCalls: ToolCall[] = [
                  ...(run.tools ?? []),
                  ...(
                    run.extra_data?.reasoning_messages ??
                    run.reasoning_messages ??
                    []
                  ).reduce((acc: ToolCall[], msg: ReasoningMessage) => {
                    if (msg.role === 'tool') {
                      acc.push({
                        role: msg.role,
                        content: msg.content,
                        tool_call_id: msg.tool_call_id ?? '',
                        tool_name: msg.tool_name ?? '',
                        tool_args: msg.tool_args ?? {},
                        tool_call_error: msg.tool_call_error ?? false,
                        metrics: msg.metrics ?? { time: 0 },
                        created_at:
                          msg.created_at ?? Math.floor(Date.now() / 1000)
                      })
                    }
                    return acc
                  }, [])
                ]

                const historyContext = {
                  runId: run.run_id ?? '',
                  agentId: run.agent_id,
                  sessionId
                }
                const pickerRequests = historicalPickerRequests(
                  toolCalls,
                  historyContext
                )
                const askUserRequests = historicalAskUserRequests(
                  toolCalls,
                  historyContext
                )

                /*
                 * ★ A PAUSED run's `content` is not the agent's answer.
                 *
                 * When the run pauses on a `requires_user_input` tool, Agno
                 * OVERWRITES `content` with its own narration — measured
                 * verbatim on the live endpoint as "I have tools to execute,
                 * but I need user input." The streaming path already drops it
                 * and draws the question card instead, so the transcript was
                 * clean while streaming and dirty the moment the page was
                 * refreshed: the reload path took `run.content` raw and
                 * printed Agno's internal state above the card.
                 *
                 * Suppressed here so a replayed paused turn looks like the
                 * streamed one. The card itself is unaffected — it is rebuilt
                 * from `run.tools`, which a paused run does carry (verified:
                 * `ask_questions` comes back with requires_user_input=true and
                 * its `questions_json` intact in `user_input_schema`).
                 */
                const rawContent = run.content
                const replayedContent = isAgnoPauseBoilerplate(rawContent)
                  ? ''
                  : ((rawContent as string) ?? '')

                filteredMessages.push({
                  role: 'agent',
                  content: replayedContent,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                  picker_requests:
                    pickerRequests.length > 0 ? pickerRequests : undefined,
                  ask_user_requests:
                    askUserRequests.length > 0 ? askUserRequests : undefined,
                  extra_data: run.extra_data ?? undefined,
                  images: run.images ?? undefined,
                  videos: run.videos ?? undefined,
                  audio: run.audio ?? undefined,
                  response_audio: run.response_audio ?? undefined,
                  created_at: runCreatedAt,
                  run_id: run.run_id,
                  token_usage: tokenUsage
                })
              }
              return filteredMessages
            })

            const processedMessages = messagesFor.map(
              (message: ChatMessage) => {
                if (Array.isArray(message.content)) {
                  const textContent = message.content
                    .filter((item: { type: string }) => item.type === 'text')
                    .map((item) => item.text)
                    .join(' ')

                  return {
                    ...message,
                    content: textContent
                  }
                }
                if (typeof message.content !== 'string') {
                  return {
                    ...message,
                    content: getJsonMarkdown(message.content)
                  }
                }
                return message
              }
            )

            setMessages(processedMessages)
            return processedMessages
          }
        }
      } catch {
        return null
      }
    },
    [selectedEndpoint, authToken, setMessages]
  )

  /**
   * `sessionsError` is the distinguishable state the sidebar needs: it is
   * non-null ONLY when the last list load actually failed. An empty
   * `sessionsData` with `sessionsError === null` means the account really has
   * no chats; an empty `sessionsData` with a non-null `sessionsError` means we
   * do not know, and the reason is in `.message` / `.kind` / `.status`.
   *
   * `clearSessionsError` exists so a retry button can drop the banner before
   * the next attempt resolves.
   */
  return { getSession, getSessions, sessionsError, clearSessionsError }
}

export default useSessionLoader
