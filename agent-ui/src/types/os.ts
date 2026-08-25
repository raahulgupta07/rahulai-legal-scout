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

/* ------------------------------------------------------------------ *
 * Structured question cards (`ask_user` — Agno native HITL pause/resume)
 *
 * The model writes an array of questions into the tool's `questions_json`
 * parameter; resume echoes the whole `user_input_schema` back with only the
 * `answers` field filled (a JSON string of { question_id: answer | answer[] }).
 * ------------------------------------------------------------------ */

export interface AskUserQuestion {
  id: string
  text: string
  /** Absent/empty → free-text input. Present → chip choices. */
  options?: string[]
  /** Chips become multi-select checkboxes. */
  multi_select?: boolean
  /** Adds an "Other…" chip that reveals a free-text input. */
  allow_other?: boolean
  /**
   * How a free-text answer is collected. 'date' renders a calendar picker and
   * converts the ISO value to "30 June 2026" before it is submitted.
   * Ignored when `options` are present — a chip list is already constrained.
   */
  input_type?: 'text' | 'date'
  /**
   * Optional starting value, set by the model. The only recognised value is
   * 'today' on a date question. Deliberately opt-in: a date field that
   * pre-fills itself would write today's date into a resignation letter the
   * moment the user pressed Enter without looking.
   */
  default_value?: string
}

/** A single question's answer: one value, or many for multi-select. */
export type AskUserAnswer = string | string[]

/** question id -> chosen answer, the shape written back into `answers`. */
export type AskUserAnswerMap = Record<string, AskUserAnswer>

export type AskUserStatus = 'pending' | 'answered' | 'historical'

export interface AskUserRequest {
  tool_call_id: string
  tool_name: string
  run_id: string
  agent_id?: string
  session_id?: string
  questions: AskUserQuestion[]
  user_input_schema: UserInputField[]
  /** Full ToolExecution dict as received, echoed back verbatim on resume. */
  raw_tool: Record<string, unknown>
  status: AskUserStatus
  /** Human-readable summary of the answers, for the resolved state. */
  answer_summary?: string
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
  /** Model reasoning, streamed alongside content by reasoning-capable models. */
  reasoning_content?: string
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
  /** Model reasoning, streamed alongside content. */
  reasoning_content?: string
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
  /**
   * The model's own reasoning for this turn.
   *
   * Distinct from `extra_data.reasoning_steps`, which is Agno's structured
   * step list. This is the raw `reasoning_content` gemini-3.6-flash streams on
   * RunContent. It mattered because a turn can produce reasoning and NO
   * content — the run completes, the transcript shows an empty bubble, and it
   * is indistinguishable from a stall. Rendering it collapsed means nothing the
   * model said is ever invisible.
   */
  reasoning_content?: string
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
  /** Structured `ask_user` question cards rendered inline in this message. */
  ask_user_requests?: AskUserRequest[]
  /**
   * Approval offered on the client's own initiative, because the turn ended
   * empty after a tool that owed the user a decision.
   *
   * NOT an `ask_user_requests` entry: those resume a PAUSED run through
   * /continue, and this run is completed, not paused — feeding it there would
   * try to consume a pause that does not exist. Answering this sends the chosen
   * option as an ordinary next message, the same mechanism the silent-stop
   * nudge already uses.
   */
  pending_approval?: {
    question: string
    options: string[]
  } | null
  /**
   * Token / cost / duration figures for the run that produced this message.
   *
   * Present on the AGENT message of a rehydrated run; absent on the user
   * message, because the stored run reports one set of figures for the whole
   * turn and attributing half of it to the prompt would be invented. Absent
   * (rather than zeroed) whenever the run carried no `metrics` at all.
   */
  token_usage?: MessageTokenUsage | null
  /**
   * The run this message belongs to. Both messages of a rehydrated turn carry
   * the same value, which is what lets a renderer group or de-duplicate them.
   */
  run_id?: string
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

/* ------------------------------------------------------------------ *
 * Run metrics — what a stored run actually carries
 *
 * Measured against the live `GET /sessions/{id}/runs?type=agent&db_id=…`
 * response on 2026-08-24, and against the saved paused-run captures. Every
 * key below was observed; nothing here is inferred. All are optional because
 * a PAUSED run's TOOL entries come back with `metrics: {}` (or null) even
 * though the RUN itself is fully measured — token figures live on the run,
 * never on the individual tool call.
 * ------------------------------------------------------------------ */

export interface RunMetrics {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  /** USD, already computed by the provider. */
  cost?: number
  cache_read_tokens?: number
  reasoning_tokens?: number
  /** Seconds. */
  time_to_first_token?: number
  /** Seconds. */
  duration?: number
}

/**
 * The per-message token figure the transcript renders.
 *
 * Deliberately NOT `RunMetrics` itself: a renderer should not have to know
 * that `total_tokens` may be absent while `input_tokens` is present, nor that
 * a user message has no metrics of its own. `null` means "this message has no
 * usage figure", which is a different statement from `0`.
 */
export interface MessageTokenUsage {
  input: number | null
  output: number | null
  /** `total_tokens` when the run reported one, else input+output when either exists. */
  total: number | null
  /** USD. */
  cost: number | null
  /** Wall-clock seconds for the run that produced this message. */
  duration: number | null
}

/**
 * One entry of `GET /sessions/{session_id}/runs`.
 *
 * ★ This is NOT `ChatEntry`. That interface describes an older
 * `{message, response}` envelope this endpoint does not return, and the loader
 * was reading `run.run_input` / `run.tools` through an `any` produced by
 * `Array.isArray()` narrowing — so none of those field names were ever checked
 * by the compiler.
 *
 * ★ `created_at` is a STRING here (`"2026-08-24T13:00:29Z"`), while the same
 * field on a nested tool call is an epoch INT (`1787578823`). Both were
 * measured on the live endpoint in the same response. Anything rendering a
 * timestamp must normalise; `ChatMessage.created_at` is epoch seconds.
 */
export interface SessionRun {
  run_id?: string
  parent_run_id?: string | null
  agent_id?: string
  user_id?: string | null
  status?: string
  /** The user's own message for this run. */
  run_input?: string | null
  content?: string | object | null
  reasoning_content?: string | null
  reasoning_steps?: ReasoningSteps[] | null
  /** ★ Top-level on this endpoint — NOT under `extra_data`, which is absent. */
  reasoning_messages?: ReasoningMessage[] | null
  references?: ReferenceData[] | null
  metrics?: RunMetrics | null
  tools?: ToolCall[] | null
  /** ISO-8601 string on this endpoint; epoch seconds on other Agno payloads. */
  created_at?: string | number | null
  extra_data?: AgentExtraData | null
  images?: ImageData[] | null
  videos?: VideoData[] | null
  audio?: AudioData[] | null
  response_audio?: ResponseAudio | null
}

/* ------------------------------------------------------------------ *
 * API result channel
 *
 * `getAllSessionsAPI` used to end in a bare `catch { return { data: [] } }`,
 * so a 401, a 500, a dropped connection and a genuinely empty account all
 * produced the identical value. An empty sidebar was therefore undiagnosable
 * from the UI. These types force the caller to look.
 * ------------------------------------------------------------------ */

export type ApiErrorKind =
  /** 401 — the JWT is missing or expired. Sign-in fixes it. */
  | 'unauthorized'
  /** 403 — signed in, not allowed. */
  | 'forbidden'
  /** 5xx — the server failed. */
  | 'server'
  /** Any other non-OK status. */
  | 'http'
  /** fetch() itself rejected: offline, DNS, CORS, aborted. */
  | 'network'
  /** 2xx whose body was not the JSON we expect (an HTML shell, typically). */
  | 'parse'

export interface ApiError {
  kind: ApiErrorKind
  /** HTTP status, or `null` when the request never produced a response. */
  status: number | null
  /** Short, human-readable. Safe to show in the UI. */
  message: string
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError }
