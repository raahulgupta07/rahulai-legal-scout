import { useCallback, useRef } from 'react'
import { toast } from 'sonner'

import { APIRoutes } from '@/api/routes'
import { buildContinueRunRequest } from '@/api/os'

import useChatActions from '@/hooks/useChatActions'
import { useStore } from '../store'
import {
  RunEvent,
  RunResponseContent,
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
        // Geometric catch-up: minimum ~200 chars/s, drains a burst in ~0.4s.
        const step = Math.max(3, Math.ceil(backlog / 12))
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
   * RunPaused — the agent hit a `choose_*` tool declared with
   * requires_user_input=True. Attach one picker request per paused tool to the
   * in-flight agent message so the cards render inline in the transcript.
   */
  const handleRunPaused = useCallback(
    (chunk: RunResponse) => {
      const pausedTools = (chunk.tools ?? []).filter(
        (tool) => tool.requires_user_input === true && isPickerTool(tool.tool_name)
      )
      if (pausedTools.length === 0) return

      setMessages((prevMessages) => {
        const newMessages = [...prevMessages]
        const lastMessage = newMessages[newMessages.length - 1]
        if (!lastMessage || lastMessage.role !== 'agent') return prevMessages

        const priorToolCalls = lastMessage.tool_calls ?? []
        const existing = lastMessage.picker_requests ?? []
        const requests: PickerRequest[] = [...existing]

        for (const tool of pausedTools) {
          if (requests.some((r) => r.tool_call_id === tool.tool_call_id)) continue
          requests.push(
            buildPickerRequest(tool, {
              runId: chunk.run_id ?? '',
              agentId: chunk.agent_id,
              sessionId: chunk.session_id,
              priorToolCalls
            })
          )
        }

        newMessages[newMessages.length - 1] = {
          ...lastMessage,
          picker_requests: requests,
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
        setMessages((prevMessages) => {
          const newMessages = prevMessages.map((message, index) => {
            if (index === prevMessages.length - 1 && message.role === 'agent') {
              let updatedContent: string
              if (typeof chunk.content === 'string') {
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

  /**
   * Resumes a paused run with the user's picker selection.
   *
   * POST {endpoint}/agents/{agent_id}/runs/{run_id}/continue as multipart form:
   *   tools       = [ <the paused ToolExecution, verbatim, with only the
   *                   `selected` entry of user_input_schema given a value> ]
   *   session_id  = current session
   *   user_id     = localStorage ls_user.id
   *   stream      = true
   * Same run_id, so history stays intact.
   */
  const continueRun = useCallback(
    async (
      request: PickerRequest,
      selection: PickerSelectionEntry | PickerSelectionEntry[]
    ) => {
      const summary = summariseSelection(selection)

      if (!request.run_id) {
        toast.error('Cannot resume: this request has no run id.')
        return
      }
      const resolvedAgentId = request.agent_id ?? agentId
      if (!resolvedAgentId) {
        toast.error('Cannot resume: no agent selected.')
        return
      }

      // Disable the card immediately — the run can only be continued once.
      setPickerStatus(request.tool_call_id, 'answered', summary)
      setIsStreaming(true)

      const endpointUrl = constructEndpointUrl(selectedEndpoint)
      const { url, headers, formData } = buildContinueRunRequest(
        endpointUrl,
        { ...request, agent_id: resolvedAgentId },
        selection,
        {
          authToken,
          sessionId: sessionId ?? request.session_id ?? '',
          userId: getLocalUserId()
        }
      )

      // The resumed response streams into a NEW agent message so the answered
      // card stays visible above it.
      addMessage({
        role: 'agent',
        content: '',
        tool_calls: [],
        streamingError: false,
        created_at: Math.floor(Date.now() / 1000)
      })

      lastContentRef.current = ''
      streamTargetRef.current = ''
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
            setPickerStatus(request.tool_call_id, 'pending')
            updateMessagesWithErrorState()
            setStreamingErrorMessage(error.message)
            toast.error(`Could not resume the run: ${error.message}`)
          },
          onComplete: () => {}
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        setPickerStatus(request.tool_call_id, 'pending')
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
      setPickerStatus,
      selectedEndpoint,
      sessionId,
      setAbortController,
      setIsStreaming,
      setStreamingErrorMessage,
      streamResponse,
      updateMessagesWithErrorState
    ]
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

        // Create headers with auth token if available
        const headers: Record<string, string> = {}
        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`
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

  return { handleStreamResponse, cancelStream, continueRun }
}

export default useAIChatStreamHandler
