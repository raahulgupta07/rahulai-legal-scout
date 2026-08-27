/* ------------------------------------------------------------------ *
 * Tool debt — "this run ended still owing a tool call".
 *
 * MEASURED DEFECT (session 75400f45-49c5-4fb1-aa1b-d97a555ee6cd, read back
 * from ai.agno_sessions on the live box). ONE user request cost THREE runs,
 * because twice the model ended a turn without making the call its own tool
 * result had just demanded, and the user had to type "continue" by hand:
 *
 *   run 1  COMPLETED  ask_questions, lookup_director_candidates
 *          lookup_director_candidates came back with
 *          agent_instruction "ACT NOW, IN THIS SAME TURN ... Call
 *          choose_director now ... There is no reason to stop here."
 *          The model wrote a prose "Preview Summary" paragraph and stopped.
 *          No picker card was ever drawn, so there was nothing to click.
 *   run 2  COMPLETED  choose_director, generate_document
 *          generate_document came back success=false, error "Undeclared
 *          blank fields", blank_fields = address, country_of_residence,
 *          date, email, phone — nothing written, no file. The model wrote
 *          another confident paragraph and stopped. No question card.
 *   run 3  PAUSED     ask_questions   <- what run 2 already owed.
 *
 * Why the hook's existing silent-stop guard could not see either stall: it
 * fires only on `chunk.content.trim() === ''`. Both of these turns ended with
 * polished prose, so `finishedEmpty` was false and no recovery ran. Ending
 * with a confident-sounding paragraph is WORSE than ending silently — a blank
 * bubble at least looks broken, while a "Preview Summary" looks finished, so
 * the user has no way to tell the turn stalled.
 *
 * The detection here is deliberately structural, never linguistic. The
 * agent_instruction strings above are English written for the model, and they
 * get reworded whenever the prompt is tuned; a guard that grepped them would
 * rot silently the next time someone edits smart_doc.py. Every rule below
 * reads a KEY that the Python tool constructs by name:
 *
 *   - people_picker.py `_payload()` stamps `picker` into every lookup result
 *     ("choose_director", "choose_attendees", "choose_representative_director",
 *     "choose_person_from_register"), and slot_resolver.py additionally stamps
 *     `lookup_tool`. That key IS the name of the call the lookup owes.
 *   - smart_doc.py returns success=false with `user_input_fields` (line ~1447)
 *     or `blank_fields` (line ~1669) when it refuses to write the file. Both
 *     mean the same thing: values are missing, so `ask_questions` is owed.
 *
 * This module is pure and dependency-free by design so the debt rule can be
 * exercised on its own against recorded payload shapes, rather than only ever
 * being observed through a live stream.
 * ------------------------------------------------------------------ */

import { parseToolPayload } from './ChatArea/Messages/toolDisplay'
import { PICKER_TOOL_PREFIX, isPickerTool } from './pickerPayload'
import { ASK_USER_TOOL, isAskUserTool } from './askUserPayload'

/**
 * One tool call as it was observed during a single run.
 *
 * Collected from the ToolCallStarted / ToolCallCompleted events as the stream
 * arrives, because RunCompleted carries NO `tools` key at all (verified on the
 * live stream — see `toolsThisRunRef` in useAIStreamHandler.tsx). By the time
 * the run is over the evidence is gone unless it was kept.
 */
export type RunToolRecord = {
  tool_name: string
  /** Raw result as it reached the browser: JSON string, Python repr, or object. */
  result?: unknown
}

/** A follow-up call a tool result demanded and the run never made. */
export type ToolDebt = {
  /** The tool that should have been called, e.g. "choose_director". */
  owes: string
  /** The tool whose result demanded it, e.g. "lookup_director_candidates". */
  owedBy: string
  /** Which structural rule fired — for the console line, not for the user. */
  reason: 'picker-never-drawn' | 'fields-never-asked'
}

/**
 * Document tools that refuse to write a file when values are missing, and say
 * so in a machine-readable way. `preview_doc` is listed because it runs the
 * same field-classification path; a preview that comes back success=false with
 * outstanding fields owes the same question the generator would.
 */
const FIELD_DEBT_TOOLS = new Set([
  'generate_document',
  'prepare_document',
  'preview_doc'
])

/** True for a key that is present AND carries at least one entry. */
const hasEntries = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0

/**
 * The call this one tool result demands, or null if it demands nothing.
 *
 * Split out from the run-level walk below so each rule can be read on its own.
 * Returns the OWED TOOL NAME, not a boolean, because the discharge test is
 * "was that exact tool called in this run" — a lookup that owes
 * `choose_director` is not satisfied by some other picker having run.
 */
const debtFromResult = (record: RunToolRecord): string | null => {
  const name = record.tool_name
  if (!name) return null

  // A picker result also carries `picker` (it echoes its own name back). It is
  // the discharge, never the debt, so it must be excluded before the key is
  // read — otherwise choose_director would be recorded as owing itself.
  if (isPickerTool(name) || isAskUserTool(name)) return null

  const result = parseToolPayload(record.result)
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const payload = result as Record<string, unknown>

  // Rule 1 — a lookup owes the picker it names.
  //
  // Gated on the tool being a lookup rather than on the key alone: `picker` is
  // a generic-looking word and a future tool could carry it for some unrelated
  // reason, whereas "a lookup_* tool returned a picker name" is exactly the
  // measured run-1 shape and nothing else. slot_resolver.py's payload also
  // stamps `lookup_tool`, so that is accepted as the same evidence.
  const looksLikeLookup =
    name.startsWith('lookup_') || typeof payload.lookup_tool === 'string'
  if (looksLikeLookup) {
    const picker = payload.picker
    if (typeof picker === 'string' && picker.startsWith(PICKER_TOOL_PREFIX)) {
      return picker
    }
  }

  // Rule 2 — a refused document owes the question that would unblock it.
  //
  // `success !== false` is not enough on its own: the generator returns
  // success=true with a file_name and a download_url, and that turn owes
  // NOTHING — it is finished, and nudging it is how the same document got
  // generated three times before the nudge budget existed. So both halves are
  // required: it failed, AND it named fields that are still missing.
  if (FIELD_DEBT_TOOLS.has(name) && payload.success === false) {
    if (hasEntries(payload.user_input_fields) || hasEntries(payload.blank_fields)) {
      return ASK_USER_TOOL
    }
  }

  return null
}

/**
 * The first debt this run incurred and never discharged, or null.
 *
 * `paused` discharges EVERYTHING, unconditionally. A paused run means a card
 * — the picker, or the question form — is on screen right now waiting for the
 * user, which is precisely the outcome the debt was asking for. Nudging there
 * would talk over a card the user is mid-way through answering, and would send
 * a synthetic "continue" into a run that is already blocked on a human. Run 3
 * of the measured session is this case: it called ask_questions and PAUSED,
 * and it owed nothing.
 *
 * Order matters only in that the FIRST outstanding debt is reported; a run
 * that owes two things gets nudged once, and the second debt (if the model
 * stalls again) is caught by the next RunCompleted, still inside the same
 * MAX_CONSECUTIVE_NUDGES budget.
 */
export const findUnpaidToolDebt = (
  tools: RunToolRecord[],
  options: { paused: boolean }
): ToolDebt | null => {
  if (options.paused) return null
  if (!tools.length) return null

  const called = new Set(tools.map((t) => t.tool_name).filter(Boolean))

  for (const record of tools) {
    const owes = debtFromResult(record)
    if (!owes) continue
    if (called.has(owes)) continue
    return {
      owes,
      owedBy: record.tool_name,
      reason: owes === ASK_USER_TOOL ? 'fields-never-asked' : 'picker-never-drawn'
    }
  }

  return null
}
