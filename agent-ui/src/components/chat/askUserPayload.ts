import type {
  AskUserAnswer,
  AskUserAnswerMap,
  AskUserQuestion,
  AskUserRequest,
  ToolCall,
  UserInputField
} from '@/types/os'

/** The single HITL tool that pauses a run to ask the user structured questions. */
export const ASK_USER_TOOL = 'ask_user'

export const isAskUserTool = (toolName?: string | null): boolean =>
  toolName === ASK_USER_TOOL

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
    questions.push({
      id,
      text,
      options: options && options.length ? options : undefined,
      multi_select: obj.multi_select === true,
      allow_other: obj.allow_other === true
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

/**
 * Reconstructs an answer summary from a finished tool result, for cards
 * rehydrated from session history. The resumed tool echoes the `answers` map;
 * we tolerate either a bare map or one nested under an `answers` key.
 */
export const summariseAnswersFromResult = (
  questions: AskUserQuestion[],
  result: string | null | undefined
): string | undefined => {
  if (!result) return undefined
  try {
    const parsed = JSON.parse(result)
    const map =
      parsed && typeof parsed === 'object' && 'answers' in parsed
        ? (parsed as { answers: unknown }).answers
        : parsed
    if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined
    const summary = summariseAnswers(questions, map as AskUserAnswerMap)
    return summary || undefined
  } catch {
    return undefined
  }
}
