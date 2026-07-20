export interface ToolCall {
  role: 'user' | 'tool' | 'system' | 'assistant'
  content: string | null
  tool_call_id: string
  tool_name: string
  tool_args: Record<string, string>
  tool_call_error: boolean
  metrics: {
    time: number
  }
  created_at: number
  /** ToolExecution.result — present on ToolCallCompleted and in session history. */
  result?: string | null
  requires_user_input?: boolean | null
  user_input_schema?: UserInputField[] | null
  answered?: boolean | null
}

/* ------------------------------------------------------------------ *
 * Interactive people picker (Agno native HITL pause/resume)
 * ------------------------------------------------------------------ */

export interface PickerRepresentative {
  id: string
  name: string
  identifier?: string
  subtitle?: string
  party_type?: 'individual' | 'corporate'
  source?: string
}

export interface PickerCandidate {
  id: string
  name: string
  identifier?: string
  subtitle?: string
  party_type: 'individual' | 'corporate'
  source?: string
  representatives?: PickerRepresentative[]
}

export interface PickerNewPersonField {
  name: string
  label: string
  required?: boolean
}

export interface PickerCompany {
  id?: number | string
  name?: string
  registration_number?: string
}

export interface PickerPayload {
  picker: string
  purpose?: string
  company?: PickerCompany
  multi_select: boolean
  candidates: PickerCandidate[]
  allow_new: boolean
  new_person_fields?: PickerNewPersonField[]
  note?: string
  error?: string
}

/** Mirrors agno.tools.function.UserInputField.to_dict() */
export interface UserInputField {
  name: string
  field_type: string
  description: string | null
  value: unknown
}

/**
 * `pending`    — live, clickable, this browser tab owns the paused run.
 * `answered`   — answered in this tab; resolved, read-only.
 * `historical` — rehydrated from session history; always read-only.
 */
export type PickerStatus = 'pending' | 'answered' | 'historical'

export interface PickerSelectionEntry {
  id?: string
  name: string
  identifier?: string
  party_type?: 'individual' | 'corporate'
  is_new?: boolean
  representative?: PickerRepresentative | null
  [key: string]: unknown
}

export interface PickerRequest {
  tool_call_id: string
  tool_name: string
  run_id: string
  agent_id?: string
  session_id?: string
  payload: PickerPayload
  user_input_schema: UserInputField[]
  /** Full ToolExecution dict as received, echoed back verbatim on resume. */
  raw_tool: Record<string, unknown>
  status: PickerStatus
  /** Human-readable summary of what was chosen, for the resolved state. */
  answer_summary?: string
  /** Payload could not be recovered from either the picker or the lookup tool. */
  parse_error?: string
  /** Which fallback tier the candidate payload came from (diagnostics). */
  payload_source?: string
}

export interface ReasoningSteps {
  title: string
  action?: string
  result: string
  reasoning: string
  confidence?: number
  next_action?: string
}
export interface ReasoningStepProps {
  index: number
  stepTitle: string
}
export interface ReasoningProps {
  reasoning: ReasoningSteps[]
}

export type ToolCallProps = {
  tools: ToolCall
}
interface ModelMessage {
  content: string | null
  context?: MessageContext[]
  created_at: number
  metrics?: {
    time: number
    prompt_tokens: number
    input_tokens: number
    completion_tokens: number
    output_tokens: number
  }
  name: string | null
  role: string
  tool_args?: unknown
  tool_call_id: string | null
  tool_calls: Array<{
    function: {
      arguments: string
      name: string
    }
    id: string
    type: string
  }> | null
}

export interface Model {
  name: string
  model: string
  provider: string
}

export interface Agent {
  agent_id: string
  name: string
  description: string
  model: Model
  storage?: boolean
}

export interface Team {
  team_id: string
  name: string
  description: string
  model: Model
  storage?: boolean
}

interface MessageContext {
  query: string
  docs?: Array<Record<string, object>>
  time?: number
}

export enum RunEvent {
  RunStarted = 'RunStarted',
  RunContent = 'RunContent',
  RunCompleted = 'RunCompleted',
  RunError = 'RunError',
  RunOutput = 'RunOutput',
  UpdatingMemory = 'UpdatingMemory',
  ToolCallStarted = 'ToolCallStarted',
  ToolCallCompleted = 'ToolCallCompleted',
  MemoryUpdateStarted = 'MemoryUpdateStarted',
  MemoryUpdateCompleted = 'MemoryUpdateCompleted',
  ReasoningStarted = 'ReasoningStarted',
  ReasoningStep = 'ReasoningStep',
  ReasoningCompleted = 'ReasoningCompleted',
  RunCancelled = 'RunCancelled',
  RunPaused = 'RunPaused',
  RunContinued = 'RunContinued',
  // Team Events
  TeamRunStarted = 'TeamRunStarted',
  TeamRunContent = 'TeamRunContent',
  TeamRunCompleted = 'TeamRunCompleted',
  TeamRunError = 'TeamRunError',
  TeamRunCancelled = 'TeamRunCancelled',
  TeamToolCallStarted = 'TeamToolCallStarted',
  TeamToolCallCompleted = 'TeamToolCallCompleted',
  TeamReasoningStarted = 'TeamReasoningStarted',
  TeamReasoningStep = 'TeamReasoningStep',
  TeamReasoningCompleted = 'TeamReasoningCompleted',
  TeamMemoryUpdateStarted = 'TeamMemoryUpdateStarted',
  TeamMemoryUpdateCompleted = 'TeamMemoryUpdateCompleted'
}

export interface ResponseAudio {
  id?: string
  content?: string
  transcript?: string
  channels?: number
  sample_rate?: number
}

export interface NewRunResponse {
  status: 'RUNNING' | 'PAUSED' | 'CANCELLED'
}

export interface RunResponseContent {
  content?: string | object
  content_type: string
  context?: MessageContext[]
  event: RunEvent
  event_data?: object
  messages?: ModelMessage[]
  metrics?: object
  model?: string
  run_id?: string
  agent_id?: string
  session_id?: string
  tool?: ToolCall
  tools?: Array<ToolCall>
  created_at: number
  extra_data?: AgentExtraData
  images?: ImageData[]
  videos?: VideoData[]
  audio?: AudioData[]
  response_audio?: ResponseAudio
}

export interface RunResponse {
  content?: string | object
  content_type: string
  context?: MessageContext[]
  event: RunEvent
  event_data?: object
  messages?: ModelMessage[]
  metrics?: object
  model?: string
  run_id?: string
  agent_id?: string
  session_id?: string
  tool?: ToolCall
  tools?: Array<ToolCall>
  created_at: number
  extra_data?: AgentExtraData
  images?: ImageData[]
  videos?: VideoData[]
  audio?: AudioData[]
  response_audio?: ResponseAudio
}

export interface AgentExtraData {
  reasoning_steps?: ReasoningSteps[]
  reasoning_messages?: ReasoningMessage[]
  references?: ReferenceData[]
}

export interface AgentExtraData {
  reasoning_messages?: ReasoningMessage[]
  references?: ReferenceData[]
}

export interface ReasoningMessage {
  role: 'user' | 'tool' | 'system' | 'assistant'
  content: string | null
  tool_call_id?: string
  tool_name?: string
  tool_args?: Record<string, string>
  tool_call_error?: boolean
  metrics?: {
    time: number
  }
  created_at?: number
}
export interface ChatMessage {
  role: 'user' | 'agent' | 'system' | 'tool'
  content: string
  streamingError?: boolean
  created_at: number
  tool_calls?: ToolCall[]
  extra_data?: {
    reasoning_steps?: ReasoningSteps[]
    reasoning_messages?: ReasoningMessage[]
    references?: ReferenceData[]
  }
  images?: ImageData[]
  videos?: VideoData[]
  audio?: AudioData[]
  response_audio?: ResponseAudio
  attachments?: AttachmentData[]
  /** Interactive picker cards rendered inline in this message. */
  picker_requests?: PickerRequest[]
}

export interface AttachmentData {
  name: string
  type: 'template' | 'knowledge'
  size?: number
  status?: 'pending' | 'analyzing' | 'uploading' | 'approved' | 'rejected'
  needsApproval?: boolean
}

export interface AgentDetails {
  id: string
  name?: string
  db_id?: string
  // Model
  model?: Model
}

export interface TeamDetails {
  id: string
  name?: string
  db_id?: string

  // Model
  model?: Model
}

export interface ImageData {
  revised_prompt: string
  url: string
}

export interface VideoData {
  id: number
  eta: number
  url: string
}

export interface AudioData {
  base64_audio?: string
  mime_type?: string
  url?: string
  id?: string
  content?: string
  channels?: number
  sample_rate?: number
}

export interface ReferenceData {
  query: string
  references: Reference[]
  time?: number
}

export interface Reference {
  content: string
  meta_data: {
    chunk: number
    chunk_size: number
  }
  name: string
}

export interface SessionEntry {
  session_id: string
  session_name: string
  created_at: number
  updated_at?: number
}

export interface Pagination {
  page: number
  limit: number
  total_pages: number
  total_count: number
}

export interface Sessions extends SessionEntry {
  data: SessionEntry[]
  meta: Pagination
}

export interface ChatEntry {
  message: {
    role: 'user' | 'system' | 'tool' | 'assistant'
    content: string
    created_at: number
  }
  response: {
    content: string
    tools?: ToolCall[]
    extra_data?: {
      reasoning_steps?: ReasoningSteps[]
      reasoning_messages?: ReasoningMessage[]
      references?: ReferenceData[]
    }
    images?: ImageData[]
    videos?: VideoData[]
    audio?: AudioData[]
    response_audio?: {
      transcript?: string
    }
    created_at: number
  }
}
