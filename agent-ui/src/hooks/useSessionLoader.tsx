import { useCallback } from 'react'
import { getSessionAPI, getAllSessionsAPI } from '@/api/os'
import { useStore } from '../store'
import { toast } from 'sonner'
import {
  ChatMessage,
  ToolCall,
  ReasoningMessage,
  ChatEntry,
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
    .filter(
      (toolCall) =>
        toolCall.requires_user_input === true && isPickerTool(toolCall.tool_name)
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

      return {
        ...request,
        status: 'historical' as const,
        answer_summary: answerSummary
      }
    })

/**
 * Rebuilds `ask_user` question cards from a past run. Always read-only, for the
 * same reason as the pickers: the paused run this tab no longer owns. Unusable
 * (bad JSON) questions are dropped rather than rendered broken.
 */
const historicalAskUserRequests = (
  toolCalls: ToolCall[],
  context: { runId: string; agentId?: string; sessionId?: string }
): AskUserRequest[] =>
  toolCalls
    .filter(
      (toolCall) =>
        toolCall.requires_user_input === true &&
        isAskUserTool(toolCall.tool_name)
    )
    .map((toolCall): AskUserRequest | null => {
      const request = buildAskUserRequest(toolCall, context)
      if (!request) return null
      return {
        ...request,
        status: 'historical',
        answer_summary: summariseAnswersFromResult(
          request.questions,
          toolCall.result
        )
      }
    })
    .filter((request): request is AskUserRequest => request !== null)

interface SessionResponse {
  session_id: string
  agent_id: string
  user_id: string | null
  runs?: ChatEntry[]
  memory: {
    runs?: ChatEntry[]
    chats?: ChatEntry[]
  }
  agent_data: Record<string, unknown>
}

interface LoaderArgs {
  entityType: 'agent' | 'team' | null
  agentId?: string | null
  teamId?: string | null
  dbId: string | null
}

const useSessionLoader = () => {
  const setMessages = useStore((state) => state.setMessages)
  const selectedEndpoint = useStore((state) => state.selectedEndpoint)
  const authToken = useStore((state) => state.authToken)
  const setIsSessionsLoading = useStore((state) => state.setIsSessionsLoading)
  const setSessionsData = useStore((state) => state.setSessionsData)

  const getSessions = useCallback(
    async ({ entityType, agentId, teamId, dbId }: LoaderArgs) => {
      const selectedId = entityType === 'agent' ? agentId : teamId
      if (!selectedEndpoint || !entityType || !selectedId || !dbId) return

      try {
        setIsSessionsLoading(true)

        let userId: string | null = null
        if (typeof window !== 'undefined') {
          try {
            const u = JSON.parse(localStorage.getItem('ls_user') || 'null')
            if (u?.id != null) userId = String(u.id)
          } catch {}
        }

        const sessions = await getAllSessionsAPI(
          selectedEndpoint,
          entityType,
          selectedId,
          dbId,
          authToken,
          userId
        )
        setSessionsData(sessions.data ?? [])
      } catch {
        toast.error('Error loading sessions')
        setSessionsData([])
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
        const response: SessionResponse = await getSessionAPI(
          selectedEndpoint,
          entityType,
          sessionId,
          dbId,
          authToken
        )
        if (response) {
          if (Array.isArray(response)) {
            const messagesFor = response.flatMap((run) => {
              const filteredMessages: ChatMessage[] = []

              if (run) {
                filteredMessages.push({
                  role: 'user',
                  content: run.run_input ?? '',
                  created_at: run.created_at
                })
              }

              if (run) {
                const toolCalls = [
                  ...(run.tools ?? []),
                  ...(run.extra_data?.reasoning_messages ?? []).reduce(
                    (acc: ToolCall[], msg: ReasoningMessage) => {
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
                    },
                    []
                  )
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

                filteredMessages.push({
                  role: 'agent',
                  content: (run.content as string) ?? '',
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                  picker_requests:
                    pickerRequests.length > 0 ? pickerRequests : undefined,
                  ask_user_requests:
                    askUserRequests.length > 0 ? askUserRequests : undefined,
                  extra_data: run.extra_data,
                  images: run.images,
                  videos: run.videos,
                  audio: run.audio,
                  response_audio: run.response_audio,
                  created_at: run.created_at
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

  return { getSession, getSessions }
}

export default useSessionLoader
