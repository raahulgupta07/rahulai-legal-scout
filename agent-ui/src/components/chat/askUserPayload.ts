import type {
  AskUserAnswer,
  AskUserAnswerMap,
  AskUserQuestion,
  AskUserRequest,
  ToolCall,
  UserInputField
} from '@/types/os'

/** The single HITL tool that pauses a run to ask the user structured questions. */
// Backend tool name. 'ask_user' is RESERVED by agno (built-in user-feedback
// control tool hijacks the resume path) — hence ask_questions. The old name is
// still matched read-only so pre-rename history renders.
export const ASK_USER_TOOL = 'ask_questions'
const LEGACY_ASK_USER_TOOLS = new Set(['ask_user', 'ask_questions'])

export const isAskUserTool = (toolName?: string | null): boolean =>
  !!toolName && LEGACY_ASK_USER_TOOLS.has(toolName)

/**
 * Parses the model-written `questions_json` into a clean question list.
 * Returns null when the shape is unusable — the caller renders nothing rather
 * than a broken card, so a malformed pause degrades to a plain chat prompt.
 */
export const parseAskUserQuestions = (
  raw: unknown
): AskUserQuestion[] | null => {
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
  if (!Array.isArray(parsed)) return null

  const questions: AskUserQuestion[] = []
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const obj = item as Record<string, unknown>
    const text = typeof obj.text === 'string' ? obj.text.trim() : ''
    if (!text) return
    const id =
      typeof obj.id === 'string' && obj.id.trim() ? obj.id : `q${index + 1}`
    const options = Array.isArray(obj.options)
      ? obj.options.filter((o): o is string => typeof o === 'string' && !!o.trim())
      : undefined
    // Only 'date' is honoured; any other string degrades to a text box rather
    // than rendering a control nobody asked for.
    const inputType = obj.input_type === 'date' ? 'date' : undefined
    const defaultValue =
      typeof obj.default === 'string' && obj.default.trim()
        ? obj.default.trim()
        : typeof obj.default_value === 'string' && obj.default_value.trim()
          ? obj.default_value.trim()
          : undefined
    questions.push({
      id,
      text,
      options: options && options.length ? options : undefined,
      multi_select: obj.multi_select === true,
      allow_other: obj.allow_other === true,
      input_type: inputType,
      default_value: defaultValue
    })
  })

  return questions.length ? questions : null
}

/**
 * Recovers the question list for a paused `ask_user` tool.
 *
 * Tier 1: `tool_args.questions_json` (the documented happy path).
 * Tier 2: the `questions_json` entry of `user_input_schema` — agno pre-fills
 *         every parameter there, an independent copy of the same value.
 */
export const resolveAskUserQuestions = (
  toolArgs: Record<string, unknown> | undefined | null,
  userInputSchema: UserInputField[] | undefined | null
): AskUserQuestion[] | null => {
  const direct = parseAskUserQuestions(toolArgs?.questions_json)
  if (direct) return direct
  const field = (userInputSchema ?? []).find(
    (f) => f.name === 'questions_json'
  )
  return parseAskUserQuestions(field?.value)
}

/** Builds an AskUserRequest from a paused ToolExecution, or null if unusable. */
export const buildAskUserRequest = (
  tool: ToolCall,
  context: { runId: string; agentId?: string; sessionId?: string }
): AskUserRequest | null => {
  const questions = resolveAskUserQuestions(
    tool.tool_args,
    tool.user_input_schema
  )
  if (!questions) return null

  return {
    tool_call_id: tool.tool_call_id,
    tool_name: tool.tool_name,
    run_id: context.runId,
    agent_id: context.agentId,
    session_id: context.sessionId,
    questions,
    user_input_schema: tool.user_input_schema ?? [],
    raw_tool: tool as unknown as Record<string, unknown>,
    status: 'pending'
  }
}

/** The JSON string written back into the schema's `answers` field on resume. */
export const buildAnswersValue = (answers: AskUserAnswerMap): string =>
  JSON.stringify(answers)

const answerToText = (answer: AskUserAnswer | undefined): string => {
  if (answer == null) return ''
  return Array.isArray(answer) ? answer.filter(Boolean).join(', ') : answer
}

/** Short human-readable summary of what was answered, for the resolved state. */
export const summariseAnswers = (
  questions: AskUserQuestion[],
  answers: AskUserAnswerMap
): string =>
  questions
    .map((question) => answerToText(answers[question.id]))
    .filter(Boolean)
    .join(' · ')

/** Coerces a raw answers value (object or JSON string) into a clean map. */
const parseAnswerMap = (raw: unknown): AskUserAnswerMap | null => {
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out: AskUserAnswerMap = {}
  Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
    if (typeof value === 'string') out[key] = value
    else if (Array.isArray(value))
      out[key] = value.filter((v): v is string => typeof v === 'string')
  })
  return Object.keys(out).length ? out : null
}

/**
 * The answers the user already gave, for a card rehydrated from history.
 *
 * On resume agno writes them into the `answers` entry of `user_input_schema`
 * (NOT the tool `result`, which stays null for `ask_user`). So a completed
 * pause is recognised by a non-empty `answers` value there.
 */
export const resolveAskUserAnswers = (
  userInputSchema: UserInputField[] | undefined | null,
  toolArgs?: Record<string, unknown> | null
): AskUserAnswerMap | null => {
  const fromSchema = (userInputSchema ?? []).find((f) => f.name === 'answers')
  return parseAnswerMap(fromSchema?.value) ?? parseAnswerMap(toolArgs?.answers)
}

/**
 * Reconstructs an answer summary from a finished tool result, for cards
 * rehydrated from history. Secondary to the schema `answers` field — used only
 * if a backend variant echoes the map into `result` (bare or under `answers`).
 */
export const summariseAnswersFromResult = (
  questions: AskUserQuestion[],
  result: string | null | undefined
): string | undefined => {
  if (!result) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch {
    return undefined
  }
  const nested =
    parsed && typeof parsed === 'object' && 'answers' in parsed
      ? (parsed as { answers: unknown }).answers
      : parsed
  const answers = parseAnswerMap(nested)
  return answers ? summariseAnswers(questions, answers) || undefined : undefined
}
