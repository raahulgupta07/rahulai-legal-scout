import type {
  PickerPayload,
  PickerRequest,
  PickerSelectionEntry,
  ToolCall,
  UserInputField
} from '@/types/os'

/** Picker tools pause the run; each has a matching non-pausing lookup tool. */
export const PICKER_TOOL_PREFIX = 'choose_'

export const PICKER_TO_LOOKUP: Record<string, string> = {
  choose_director: 'lookup_director_candidates',
  choose_representative_director: 'lookup_representative_candidates',
  choose_attendees: 'lookup_attendee_candidates',
  choose_person_from_register: 'lookup_register_candidates'
}

export const isPickerTool = (toolName?: string | null): boolean =>
  !!toolName && toolName.startsWith(PICKER_TOOL_PREFIX)

const normalise = (value: unknown): string =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Parses a candidates payload; returns null when the shape is unusable. */
export const parsePickerPayload = (raw: unknown): PickerPayload | null => {
  if (raw == null) return null
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.candidates)) return null

  return {
    picker: typeof obj.picker === 'string' ? obj.picker : '',
    purpose: typeof obj.purpose === 'string' ? obj.purpose : '',
    company:
      typeof obj.company === 'object' && obj.company !== null
        ? (obj.company as PickerPayload['company'])
        : {},
    multi_select: obj.multi_select === true,
    candidates: (obj.candidates as PickerPayload['candidates']).filter(
      (candidate) => !!candidate && typeof candidate === 'object'
    ),
    allow_new: obj.allow_new !== false,
    new_person_fields: Array.isArray(obj.new_person_fields)
      ? (obj.new_person_fields as PickerPayload['new_person_fields'])
      : [],
    note: typeof obj.note === 'string' ? obj.note : '',
    error: typeof obj.error === 'string' ? obj.error : undefined
  }
}

/** The company name the picker tool was invoked for, whatever the arg is called. */
export const pickerCompanyArg = (
  toolArgs: Record<string, unknown> | undefined | null
): string => {
  if (!toolArgs) return ''
  const candidateKeys = [
    'corporate_shareholder_name',
    'company_name',
    'document_company'
  ]
  for (const key of candidateKeys) {
    const value = toolArgs[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/**
 * Recovers the candidate payload for a paused picker tool.
 *
 * Tier 1: `tool_args.candidates_json` (the documented happy path).
 * Tier 2: the `candidates_json` entry of `user_input_schema` — agno pre-fills
 *         every parameter there, so it is an independent copy of the same value.
 * Tier 3: the result of the preceding `lookup_*` tool call, correlated on
 *         `company.name`. Used when the model omits or mangles candidates_json.
 */
export const resolvePickerPayload = (
  toolName: string,
  toolArgs: Record<string, unknown> | undefined | null,
  userInputSchema: UserInputField[] | undefined | null,
  priorToolCalls: ToolCall[] | undefined
): { payload: PickerPayload | null; source: string } => {
  const direct = parsePickerPayload(toolArgs?.candidates_json)
  if (direct) return { payload: direct, source: 'tool_args' }

  const schemaField = (userInputSchema ?? []).find(
    (field) => field.name === 'candidates_json'
  )
  const fromSchema = parsePickerPayload(schemaField?.value)
  if (fromSchema) return { payload: fromSchema, source: 'user_input_schema' }

  const lookupName = PICKER_TO_LOOKUP[toolName]
  if (!lookupName || !priorToolCalls?.length) {
    return { payload: null, source: 'none' }
  }

  const wanted = normalise(pickerCompanyArg(toolArgs))
  const matches = priorToolCalls.filter((tc) => tc.tool_name === lookupName)

  let best: PickerPayload | null = null
  for (const toolCall of matches) {
    const payload = parsePickerPayload(toolCall.result ?? toolCall.content)
    if (!payload) continue
    const name = normalise(payload.company?.name)
    if (wanted && name && (name === wanted || name.includes(wanted) || wanted.includes(name))) {
      return { payload, source: 'lookup_tool:company_match' }
    }
    // Keep the most recent parseable lookup of the right kind as a last resort.
    best = payload
  }

  return best
    ? { payload: best, source: 'lookup_tool:last_of_kind' }
    : { payload: null, source: 'none' }
}

/** Short human-readable description of what was chosen. */
export const summariseSelection = (
  selection: PickerSelectionEntry | PickerSelectionEntry[]
): string => {
  const list = Array.isArray(selection) ? selection : [selection]
  return list
    .map((entry) => {
      const rep = entry.representative?.name
      const base = entry.name || 'Unnamed'
      const suffix = rep ? ` (via ${rep})` : ''
      return entry.is_new ? `${base} (new)${suffix}` : `${base}${suffix}`
    })
    .join(', ')
}

/** Builds a PickerRequest from a paused ToolExecution. */
export const buildPickerRequest = (
  tool: ToolCall,
  context: {
    runId: string
    agentId?: string
    sessionId?: string
    priorToolCalls?: ToolCall[]
  }
): PickerRequest => {
  const { payload, source } = resolvePickerPayload(
    tool.tool_name,
    tool.tool_args,
    tool.user_input_schema,
    context.priorToolCalls
  )

  return {
    tool_call_id: tool.tool_call_id,
    tool_name: tool.tool_name,
    run_id: context.runId,
    agent_id: context.agentId,
    session_id: context.sessionId,
    payload:
      payload ?? {
        picker: tool.tool_name,
        purpose: '',
        company: {},
        multi_select: false,
        candidates: [],
        allow_new: true,
        new_person_fields: [],
        note: ''
      },
    user_input_schema: tool.user_input_schema ?? [],
    raw_tool: tool as unknown as Record<string, unknown>,
    status: 'pending',
    parse_error: payload
      ? undefined
      : `Could not read the candidate list for ${tool.tool_name} (checked tool_args, user_input_schema and the ${PICKER_TO_LOOKUP[tool.tool_name] ?? 'lookup'} result).`,
    answer_summary: undefined,
    payload_source: source
  }
}
