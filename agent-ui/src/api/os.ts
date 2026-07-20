import { toast } from 'sonner'

import { APIRoutes } from './routes'

import {
  AgentDetails,
  PickerRequest,
  PickerSelectionEntry,
  Sessions,
  TeamDetails,
  UserInputField
} from '@/types/os'

// Helper function to create headers with optional auth token
const createHeaders = (authToken?: string): HeadersInit => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json'
  }

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  return headers
}

// Auth-only headers — FormData bodies must NOT carry an explicit Content-Type,
// the browser has to set the multipart boundary itself.
const createAuthHeaders = (authToken?: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }
  return headers
}

/**
 * Builds the resume request for a paused (HITL) agent run.
 *
 * Agno's `POST /agents/{agent_id}/runs/{run_id}/continue` takes multipart form
 * fields: `tools` (JSON array of full ToolExecution dicts), `session_id`,
 * `user_id`, `stream`. The ToolExecution is echoed back verbatim with ONLY the
 * `selected` entry of `user_input_schema` filled in — its value is a JSON
 * string: an object for single-select, an ordered array for multi-select.
 */
export const buildContinueRunRequest = (
  base: string,
  request: PickerRequest,
  selection: PickerSelectionEntry | PickerSelectionEntry[],
  options: {
    authToken?: string
    sessionId?: string | null
    userId?: string | null
  } = {}
): { url: string; headers: Record<string, string>; formData: FormData } => {
  const schema: UserInputField[] = (request.user_input_schema ?? []).map(
    (field) =>
      field.name === 'selected'
        ? { ...field, value: JSON.stringify(selection) }
        : field
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

export const getAllSessionsAPI = async (
  base: string,
  type: 'agent' | 'team',
  componentId: string,
  dbId: string,
  authToken?: string,
  userId?: string | null
): Promise<Sessions | { data: [] }> => {
  try {
    const url = new URL(APIRoutes.GetSessions(base))
    url.searchParams.set('type', type)
    url.searchParams.set('component_id', componentId)
    url.searchParams.set('db_id', dbId)
    if (userId) url.searchParams.set('user_id', String(userId))

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: createHeaders(authToken)
    })

    if (!response.ok) {
      if (response.status === 404) {
        return { data: [] }
      }
      throw new Error(`Failed to fetch sessions: ${response.statusText}`)
    }
    return response.json()
  } catch {
    return { data: [] }
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

  if (response.status === 404) return null  // session not yet created — not an error
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
