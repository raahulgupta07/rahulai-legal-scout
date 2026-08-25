import { toast } from 'sonner'

import { APIRoutes } from './routes'

import {
  AgentDetails,
  ApiError,
  ApiResult,
  AskUserAnswerMap,
  AskUserRequest,
  PickerRequest,
  PickerSelectionEntry,
  SessionEntry,
  TeamDetails,
  UserInputField
} from '@/types/os'

import { buildAnswersValue } from '@/components/chat/askUserPayload'

/**
 * The JWT the app actually signs in with.
 *
 * `useStore().authToken` is a leftover from the Agno playground: it is NOT in
 * the store's `partialize`, so it is '' on every page load and only ever holds
 * a value if someone types one into the old token box. The real token lives in
 * localStorage under `ls_token` (see lib/api-client.ts).
 *
 * That gap was invisible while the AgentOS routes (/agents, /teams, /sessions)
 * were unauthenticated — they answered without a header. The moment those
 * routes were put behind the JWT, every one of them started returning 401 and
 * the workspace came up with "Failed to fetch agents: Unauthorized".
 */
const storedAuthToken = (): string => {
  if (typeof window === 'undefined') return ''
  try {
    return localStorage.getItem('ls_token') || ''
  } catch {
    return ''
  }
}

// Helper function to create headers with optional auth token
const createHeaders = (authToken?: string): HeadersInit => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json'
  }

  const token = authToken || storedAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  return headers
}

// Auth-only headers — FormData bodies must NOT carry an explicit Content-Type,
// the browser has to set the multipart boundary itself.
const createAuthHeaders = (authToken?: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  const token = authToken || storedAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

interface ResumeOptions {
  authToken?: string
  sessionId?: string | null
  userId?: string | null
}

/** The subset of a paused HITL request needed to build a /continue call. */
interface ResumableRequest {
  tool_call_id: string
  tool_name: string
  run_id: string
  agent_id?: string
  session_id?: string
  user_input_schema: UserInputField[]
  raw_tool: Record<string, unknown>
}

/**
 * Core resume request for any paused (HITL) agent run.
 *
 * Agno's `POST /agents/{agent_id}/runs/{run_id}/continue` takes multipart form
 * fields: `tools` (JSON array of full ToolExecution dicts), `session_id`,
 * `user_id`, `stream`. The ToolExecution is echoed back VERBATIM — the whole
 * `user_input_schema` is preserved and only the named `fills` entries are given
 * a value (each a JSON string). Echoing the untouched fields matters: dropping
 * a param wipes it server-side (e.g. `questions_json` for `ask_user`).
 */
const buildResumeRequest = (
  base: string,
  request: ResumableRequest,
  fills: Record<string, string>,
  options: ResumeOptions
): { url: string; headers: Record<string, string>; formData: FormData } => {
  const schema: UserInputField[] = (request.user_input_schema ?? []).map(
    (field) =>
      field.name in fills ? { ...field, value: fills[field.name] } : field
  )

  const toolPayload = {
    ...request.raw_tool,
    tool_call_id: request.tool_call_id,
    tool_name: request.tool_name,
    requires_user_input: true,
    user_input_schema: schema
  }

  const formData = new FormData()
  formData.append('tools', JSON.stringify([toolPayload]))
  formData.append('session_id', options.sessionId ?? request.session_id ?? '')
  if (options.userId) formData.append('user_id', String(options.userId))
  formData.append('stream', 'true')

  return {
    url: APIRoutes.ContinueAgentRun(
      base,
      request.agent_id ?? '',
      request.run_id
    ),
    headers: createAuthHeaders(options.authToken),
    formData
  }
}

/**
 * Resume request for the people picker: fills the `selected` schema entry — a
 * JSON string, an object for single-select or an ordered array for multi.
 */
export const buildContinueRunRequest = (
  base: string,
  request: PickerRequest,
  selection: PickerSelectionEntry | PickerSelectionEntry[],
  options: ResumeOptions = {}
): { url: string; headers: Record<string, string>; formData: FormData } =>
  buildResumeRequest(
    base,
    request,
    { selected: JSON.stringify(selection) },
    options
  )

/**
 * Resume request for `ask_user`: fills the `answers` schema entry with the
 * JSON string of { question_id: answer | answer[] }. The model-written
 * `questions_json` field is left untouched so it survives the round-trip.
 */
export const buildAskUserContinueRequest = (
  base: string,
  request: AskUserRequest,
  answers: AskUserAnswerMap,
  options: ResumeOptions = {}
): { url: string; headers: Record<string, string>; formData: FormData } =>
  buildResumeRequest(
    base,
    request,
    { answers: buildAnswersValue(answers) },
    options
  )

export const getAgentsAPI = async (
  endpoint: string,
  authToken?: string
): Promise<AgentDetails[]> => {
  const url = APIRoutes.GetAgents(endpoint)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: createHeaders(authToken)
    })
    if (!response.ok) {
      toast.error(`Failed to fetch  agents: ${response.statusText}`)
      return []
    }
    const data = await response.json()
    return data
  } catch {
    toast.error('Error fetching  agents')
    return []
  }
}

export const getStatusAPI = async (
  base: string,
  authToken?: string
): Promise<number> => {
  const response = await fetch(APIRoutes.Status(base), {
    method: 'GET',
    headers: createHeaders(authToken)
  })
  return response.status
}

/**
 * Agno's built-in "paused" narration (agno/utils/response.py).
 *
 * When a run pauses on a `requires_user_input` tool, Agno OVERWRITES the run's
 * `content` with this sentence. It describes the framework's own state, never
 * the user's task, so it must never reach the transcript — the question card
 * rebuilt from `tools` is the real content of that turn.
 *
 * ★ Single source of truth. Both paths import it from here: `useSessionLoader`
 * (reload) and `useAIStreamHandler` (stream). It previously existed as two
 * byte-identical copies, and only the stream copy was ever applied — so the
 * live transcript was clean while a refresh rendered Agno's raw sentence.
 *
 * Anchored at both ends deliberately. It matches Agno's exact sentence and its
 * "it needs" variant, and nothing else — ordinary prose that merely opens with
 * the same words carries on past the first full stop and fails the `$`.
 */
export const AGNO_PAUSE_BOILERPLATE =
  /^I have tools to execute, but (I need|it needs)\b.*\.$/i

/** True only for Agno's own pause narration — see AGNO_PAUSE_BOILERPLATE. */
export const isAgnoPauseBoilerplate = (content: unknown): boolean =>
  typeof content === 'string' && AGNO_PAUSE_BOILERPLATE.test(content.trim())

/** Classify a non-OK HTTP status into something the UI can act on. */
const errorKindForStatus = (status: number): ApiError['kind'] => {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status >= 500) return 'server'
  return 'http'
}

/**
 * Sessions for the sidebar.
 *
 * ★ This used to end in a bare `catch { return { data: [] } }`, so a 401, a
 * 500, a dropped connection and a JSON parse failure ALL returned the exact
 * value a genuinely-empty account returns. A user reporting an empty sidebar
 * could not be diagnosed from the UI at all, because "broken" and "empty" were
 * the same value. The result now carries an explicit error channel.
 *
 * A 404 is deliberately still success-with-nothing: the sessions table for a
 * component that has never run does not exist yet, which IS emptiness.
 */
export const getAllSessionsAPI = async (
  base: string,
  type: 'agent' | 'team',
  componentId: string,
  dbId: string,
  authToken?: string,
  userId?: string | null
): Promise<ApiResult<SessionEntry[]>> => {
  let response: Response
  try {
    const url = new URL(APIRoutes.GetSessions(base))
    url.searchParams.set('type', type)
    url.searchParams.set('component_id', componentId)
    url.searchParams.set('db_id', dbId)
    if (userId) url.searchParams.set('user_id', String(userId))

    response = await fetch(url.toString(), {
      method: 'GET',
      headers: createHeaders(authToken)
    })
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'network',
        status: null,
        message:
          error instanceof Error && error.message
            ? `Could not reach the server: ${error.message}`
            : 'Could not reach the server.'
      }
    }
  }

  if (!response.ok) {
    // Not an error: nothing has ever been stored for this component.
    if (response.status === 404) return { ok: true, data: [] }
    return {
      ok: false,
      error: {
        kind: errorKindForStatus(response.status),
        status: response.status,
        message:
          response.status === 401
            ? 'Your session has expired — sign in again to see your chats.'
            : `Could not load chats (${response.status} ${response.statusText || 'error'}).`
      }
    }
  }

  // A 200 is not proof of a JSON body: the frontend catch-all answers unknown
  // GETs with the Next.js HTML shell at 200, which drains fine and parses to
  // nothing. That has to read as broken, not as empty.
  try {
    const body: unknown = await response.json()
    const data = Array.isArray(body)
      ? (body as SessionEntry[])
      : ((body as { data?: SessionEntry[] } | null)?.data ?? null)
    if (!Array.isArray(data)) {
      return {
        ok: false,
        error: {
          kind: 'parse',
          status: response.status,
          message: 'The server returned an unexpected response for chats.'
        }
      }
    }
    return { ok: true, data }
  } catch {
    return {
      ok: false,
      error: {
        kind: 'parse',
        status: response.status,
        message: 'The server returned an unreadable response for chats.'
      }
    }
  }
}

export const getSessionAPI = async (
  base: string,
  type: 'agent' | 'team',
  sessionId: string,
  dbId?: string,
  authToken?: string
) => {
  // build query string
  const queryParams = new URLSearchParams({ type })
  if (dbId) queryParams.append('db_id', dbId)

  const response = await fetch(
    `${APIRoutes.GetSession(base, sessionId)}?${queryParams.toString()}`,
    {
      method: 'GET',
      headers: createHeaders(authToken)
    }
  )

  if (response.status === 404) return null // session not yet created — not an error
  if (!response.ok) {
    throw new Error(`Failed to fetch session: ${response.statusText}`)
  }

  return response.json()
}

export const deleteSessionAPI = async (
  base: string,
  dbId: string,
  sessionId: string,
  authToken?: string
) => {
  const queryParams = new URLSearchParams()
  if (dbId) queryParams.append('db_id', dbId)
  const response = await fetch(
    `${APIRoutes.DeleteSession(base, sessionId)}?${queryParams.toString()}`,
    {
      method: 'DELETE',
      headers: createHeaders(authToken)
    }
  )
  return response
}

export const getTeamsAPI = async (
  endpoint: string,
  authToken?: string
): Promise<TeamDetails[]> => {
  const url = APIRoutes.GetTeams(endpoint)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: createHeaders(authToken)
    })
    if (!response.ok) {
      toast.error(`Failed to fetch  teams: ${response.statusText}`)
      return []
    }
    const data = await response.json()

    return data
  } catch {
    toast.error('Error fetching  teams')
    return []
  }
}

export const deleteTeamSessionAPI = async (
  base: string,
  teamId: string,
  sessionId: string,
  authToken?: string
) => {
  const response = await fetch(
    APIRoutes.DeleteTeamSession(base, teamId, sessionId),
    {
      method: 'DELETE',
      headers: createHeaders(authToken)
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to delete team session: ${response.statusText}`)
  }
  return response
}
