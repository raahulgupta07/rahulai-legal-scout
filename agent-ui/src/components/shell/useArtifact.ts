'use client'

/**
 * Derives the "document currently being built" from real run state.
 *
 * PREFERRED PATH — the tools DECLARE their state. Every document tool now
 * returns a `document_state` key (smart_doc.py `_document_state`) holding the
 * field list, the counts and the status outright. When a call carries it we
 * build the artifact straight from it and run no inference at all: the tool
 * knows whether a field is filled, and guessing from six overlapping result
 * keys is what produced three separate user-visible bugs.
 *
 * FALLBACK PATH — everything below `foldToolCall`. Sessions stored before
 * `document_state` existed hold results without it, and reopening one from the
 * sidebar has to keep working. Do NOT delete the inference or
 * `parsePythonLiteral`: removing either blanks the panel on every old
 * conversation.
 *
 * The source of truth is the agent's own tool calls, streamed into
 * store.messages by useAIStreamHandler. Four tools touch a document, and
 * each returns a different shape (see scout/tools/smart_doc.py):
 *
 *   prepare_document  → template_analysis.required_fields + normalized_data
 *                       + validation.available_fields / missing_fields
 *   preview_doc       → matched_fields / missing_fields / data
 *                       (exported as "preview_document"; registered as preview_doc)
 *   generate_document → success: file_name, download_url, validation_summary
 *                       failure: user_input_fields / db_fields_filled
 *   create_document   → passthrough to generate_document
 *
 * We fold them in call order, later calls overwriting earlier ones, so the
 * panel tracks the run rather than replaying it. Nothing here animates on a
 * timer — if a field flips to filled it is because a tool said so.
 */

import { useMemo } from 'react'
import { useStore } from '@/store'
import type { ChatMessage, ToolCall } from '@/types/os'

export type FieldState = 'filled' | 'tbd' | 'pending'

export interface ArtifactField {
  /** Raw placeholder key, e.g. company_name */
  key: string
  /** Humanised for display */
  label: string
  value: string | null
  state: FieldState
}

export type ArtifactStatus =
  | 'preparing'
  | 'awaiting-input'
  | 'ready'
  | 'generated'
  | 'error'

export interface Artifact {
  title: string
  templateName: string | null
  companyName: string | null
  fields: ArtifactField[]
  status: ArtifactStatus
  /** Set once a .docx actually exists on disk. */
  fileName: string | null
  downloadUrl: string | null
  message: string | null
  filled: number
  total: number
  /**
   * Fields still to resolve. Derived here, next to `filled`/`total`, so the
   * tab badge, the meter and the "Outstanding" group header cannot disagree —
   * the panel showed "Fields 0" beside "6 blanks left" when each computed its
   * own number.
   */
  outstanding: number
}

/**
 * The names the STREAM actually carries, which are the function names — not the
 * keys `create_smart_document_tool` exports them under.
 *
 * `_as_json` wraps with @wraps, so agno registers `preview_doc` even though the
 * export key reads `preview_document`. agent.py:213 says exactly this and the
 * PROMPT was corrected for it; this set was not. The result: every `preview_doc`
 * result was filtered out here, so a run that had previewed a document but not
 * yet generated it left the panel reading "No document yet" beside a chat full
 * of that document's fields.
 *
 * Both spellings are listed so a stored session cannot lose its panel either.
 */
const DOC_TOOLS = new Set([
  'prepare_document',
  'prepare_document_data',
  'preview_doc',
  'preview_document',
  'generate_document',
  'create_document'
])

const TBD_RE = /^\s*(tbd|\[tbd[^\]]*\]|n\/?a|-{1,2})\s*$/i

/**
 * Python literal parser.
 *
 * Tool results reach the browser as `str(dict)` — Python repr, not JSON:
 * single quotes, True/False/None. Regex-rewriting quotes looks like it works
 * until a value contains an apostrophe, an escape or a curly quote (the
 * generate_document `preview` field contains all three), at which point the
 * whole payload silently fails to parse and the panel goes blank. So parse it
 * properly.
 */
function parsePythonLiteral(text: string): unknown {
  let i = 0

  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }

  const fail = (): never => {
    throw new Error(`Unexpected token at ${i}`)
  }

  const parseString = (): string => {
    const quote = text[i]
    i++
    let out = ''
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\') {
        const next = text[i + 1]
        i += 2
        switch (next) {
          case 'n': out += '\n'; break
          case 't': out += '\t'; break
          case 'r': out += '\r'; break
          case '0': out += '\0'; break
          case 'x': {
            out += String.fromCharCode(parseInt(text.slice(i, i + 2), 16))
            i += 2
            break
          }
          case 'u': {
            out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16))
            i += 4
            break
          }
          default: out += next ?? ''
        }
        continue
      }
      if (ch === quote) {
        i++
        return out
      }
      out += ch
      i++
    }
    return fail()
  }

  const parseValue = (): unknown => {
    ws()
    const ch = text[i]
    if (ch === undefined) return fail()

    if (ch === "'" || ch === '"') return parseString()

    if (ch === '{') {
      i++
      const obj: Record<string, unknown> = {}
      ws()
      if (text[i] === '}') {
        i++
        return obj
      }
      for (;;) {
        ws()
        const key = parseValue()
        ws()
        if (text[i] !== ':') return fail()
        i++
        const value = parseValue()
        // Python allows non-string keys; we only care about string-ish ones.
        obj[typeof key === 'string' ? key : String(key)] = value
        ws()
        if (text[i] === ',') {
          i++
          ws()
          if (text[i] === '}') {
            i++
            return obj
          }
          continue
        }
        if (text[i] === '}') {
          i++
          return obj
        }
        return fail()
      }
    }

    if (ch === '[' || ch === '(') {
      const close = ch === '[' ? ']' : ')'
      i++
      const arr: unknown[] = []
      ws()
      if (text[i] === close) {
        i++
        return arr
      }
      for (;;) {
        arr.push(parseValue())
        ws()
        if (text[i] === ',') {
          i++
          ws()
          if (text[i] === close) {
            i++
            return arr
          }
          continue
        }
        if (text[i] === close) {
          i++
          return arr
        }
        return fail()
      }
    }

    if (text.startsWith('True', i)) { i += 4; return true }
    if (text.startsWith('False', i)) { i += 5; return false }
    if (text.startsWith('None', i)) { i += 4; return null }

    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (num) {
      i += num[0].length
      return Number(num[0])
    }

    return fail()
  }

  const value = parseValue()
  return value
}

/**
 * Tool results arrive as a string. Since the document tools were wrapped in
 * `_as_json` (smart_doc.py) every NEW run sends real JSON, so the fast path
 * below is the one that runs.
 *
 * The Python-literal fallback stays for stored history: sessions written before
 * that change still hold `str(dict)` results, and reopening one from the
 * sidebar has to keep working. Remove the fallback only once those sessions no
 * longer matter — deleting it now blanks the panel on every old conversation.
 */
function parseResult(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text.startsWith('{')) return null

  try {
    const v = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {
    /* fall through to the Python literal parser */
  }

  try {
    const v = parsePythonLiteral(text)
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function stringify(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

export function humanise(key: string): string {
  return key
    .replace(/[{}]/g, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Mutable accumulator — folded over tool calls, then frozen into an Artifact. */
interface Draft {
  template: string | null
  company: string | null
  order: string[]
  values: Map<string, string | null>
  states: Map<string, FieldState>
  status: ArtifactStatus
  fileName: string | null
  downloadUrl: string | null
  message: string | null
  /** Counts straight from validation_summary, preferred over our own tally. */
  reportedFilled: number | null
  reportedTotal: number | null
}

/**
 * Declare a key as belonging to THIS document.
 *
 * The distinction matters: prepare_document returns `normalized_data`, which
 * is the company's entire record (~27 keys), while the template may need
 * three of them. Counting every known value would report "18/27" for a
 * document that is in fact complete. Only fields a tool named as part of the
 * template get declared; everything else is just available data.
 */
function declare(d: Draft, key: string) {
  if (!d.order.includes(key)) {
    d.order.push(key)
    if (!d.states.has(key)) d.states.set(key, 'pending')
  }
}

/** Record a known value. Does not, on its own, make the key part of the doc. */
function setValue(d: Draft, key: string, value: string | null) {
  d.values.set(key, value)
  if (value === null) return
  // A value only upgrades state; explicit pending marks below can override.
  d.states.set(key, TBD_RE.test(value) ? 'tbd' : 'filled')
}

/**
 * A tool has said this field is not resolved. That verdict beats any value we
 * happen to hold — but if we do hold one, surface it as an unconfirmed
 * candidate rather than hiding it behind "Pending".
 */
function markPending(d: Draft, key: string) {
  declare(d, key)
  d.states.set(key, d.values.get(key) ? 'tbd' : 'pending')
}

function foldToolCall(d: Draft, call: ToolCall) {
  const args = asRecord(call.tool_args)
  const template = stringify(args.template_name)
  const company = stringify(args.company_name)
  if (template) d.template = template
  if (company) d.company = company

  const res = parseResult(call.result ?? call.content)
  if (!res) {
    // A call we can't read still tells us the agent is mid-document.
    if (d.status === 'preparing') d.status = 'preparing'
    return
  }

  const resTemplate = stringify(res.template_name)
  const resCompany = stringify(res.company_name)
  if (resTemplate) d.template = resTemplate
  if (resCompany) d.company = resCompany

  const msg = stringify(res.message)
  if (msg) d.message = msg

  if (call.tool_call_error) {
    d.status = 'error'
  }

  // ---- field discovery: declare the document's own field list first, so
  // pending fields are visible before anything resolves them.
  const analysis = asRecord(res.template_analysis)
  const validation = asRecord(res.validation)
  for (const f of asStringArray(analysis.required_fields)) declare(d, f)
  for (const f of asStringArray(res.matched_fields)) declare(d, f)
  for (const f of asStringArray(res.missing_fields)) declare(d, f)
  for (const f of asStringArray(res.user_input_fields)) declare(d, f)
  for (const f of asStringArray(validation.available_fields)) declare(d, f)
  for (const f of asStringArray(validation.missing_fields)) declare(d, f)

  // ---- values.
  // normalized_data is the whole company record — a value source, not a field
  // list. The rest are template-scoped, so they both declare and fill.
  for (const [k, v] of Object.entries(asRecord(res.normalized_data))) {
    setValue(d, k, stringify(v))
  }
  for (const [k, v] of Object.entries(asRecord(res.company_data))) {
    setValue(d, k, stringify(v))
  }
  for (const source of ['data', 'field_defaults', 'db_fields_filled'] as const) {
    for (const [k, v] of Object.entries(asRecord(res[source]))) {
      declare(d, k)
      setValue(d, k, stringify(v))
    }
  }

  // ---- explicit pending / filled signals win over inferred ones
  for (const f of asStringArray(res.matched_fields)) {
    if (d.states.get(f) === 'pending') d.states.set(f, 'filled')
  }
  for (const f of asStringArray(validation.available_fields)) {
    if (d.states.get(f) === 'pending') d.states.set(f, 'filled')
  }
  for (const f of asStringArray(res.missing_fields)) markPending(d, f)
  for (const f of asStringArray(validation.missing_fields)) markPending(d, f)
  for (const f of asStringArray(res.user_input_fields)) markPending(d, f)
  for (const f of asStringArray(res.unresolved_slots)) markPending(d, f)

  // ---- status + output
  const success = res.success
  if (success === false) {
    d.status = asStringArray(res.user_input_fields).length ||
      asStringArray(res.unresolved_slots).length
      ? 'awaiting-input'
      : 'error'
    return
  }

  const summary = asRecord(res.validation_summary)
  const total = summary.total_placeholders
  const filled = summary.filled_from_data
  if (typeof total === 'number') d.reportedTotal = total
  if (typeof filled === 'number') d.reportedFilled = filled
  for (const f of asStringArray(summary.unfilled_fields)) markPending(d, f)

  const fileName = stringify(res.file_name)
  const downloadUrl = stringify(res.download_url)
  if (fileName) d.fileName = fileName
  if (downloadUrl) d.downloadUrl = downloadUrl

  if (fileName || downloadUrl) {
    d.status = 'generated'
  } else if (res.ready_to_generate === true) {
    d.status = 'ready'
  } else if (d.status !== 'awaiting-input' && d.status !== 'error') {
    d.status = 'preparing'
  }
}

const STATUSES: ReadonlySet<string> = new Set([
  'preparing',
  'awaiting-input',
  'ready',
  'generated',
  'error'
])

const FIELD_STATES: ReadonlySet<string> = new Set(['filled', 'tbd', 'pending'])

/**
 * The ONE place every count in the panel comes from.
 *
 * The enumerated fields win whenever there are any: a header saying "6
 * outstanding" above two rows is the same contradiction in a different place.
 * The reported totals are used only when no field list exists at all (an older
 * result that carried validation_summary and nothing else).
 */
function deriveCounts(
  fields: ArtifactField[],
  reportedFilled: number | null,
  reportedTotal: number | null
): { filled: number; total: number; outstanding: number } {
  if (fields.length) {
    const filled = fields.filter((f) => f.state === 'filled').length
    return { filled, total: fields.length, outstanding: fields.length - filled }
  }
  const total = reportedTotal ?? 0
  const filled = Math.min(Math.max(reportedFilled ?? 0, 0), total)
  return { filled, total, outstanding: total - filled }
}

/** Build the artifact from a tool's own declaration — no inference. */
function fromDeclared(
  state: Record<string, unknown>,
  message: string | null
): Artifact {
  const template = stringify(state.template)
  const company = stringify(state.company)

  const raw = Array.isArray(state.fields) ? state.fields : []
  const fields: ArtifactField[] = []
  for (const entry of raw) {
    const f = asRecord(entry)
    const key = stringify(f.key)
    if (!key) continue
    const value = stringify(f.value)
    const declaredState = stringify(f.state)
    fields.push({
      key,
      label: humanise(key),
      value,
      // A state we don't recognise is treated as unknown rather than trusted.
      state: (declaredState && FIELD_STATES.has(declaredState)
        ? declaredState
        : value
          ? 'filled'
          : 'pending') as FieldState
    })
  }

  const declaredStatus = stringify(state.status)
  const status: ArtifactStatus = (
    declaredStatus && STATUSES.has(declaredStatus) ? declaredStatus : 'preparing'
  ) as ArtifactStatus

  const fileName = stringify(state.file_name)
  const counts = deriveCounts(
    fields,
    typeof state.filled === 'number' ? state.filled : null,
    typeof state.total === 'number' ? state.total : null
  )

  return {
    title:
      fileName ??
      (template ? (company ? `${template} — ${company}` : template) : 'Untitled document'),
    templateName: template,
    companyName: company,
    fields,
    status,
    fileName,
    downloadUrl: stringify(state.download_url),
    message,
    ...counts
  }
}

export function deriveArtifact(messages: ChatMessage[]): Artifact | null {
  const calls: ToolCall[] = []
  for (const m of messages) {
    for (const c of m.tool_calls ?? []) {
      if (DOC_TOOLS.has(c.tool_name)) calls.push(c)
    }
  }
  if (!calls.length) return null

  // Declared state wins, latest call last — the run's own account of the
  // document, so nothing below needs to run.
  let declared: Record<string, unknown> | null = null
  let declaredMessage: string | null = null
  for (const call of calls) {
    const res = parseResult(call.result ?? call.content)
    if (!res) continue
    const state = asRecord(res.document_state)
    if (!Object.keys(state).length) continue
    declared = state
    // The tool's own sentence, which the panel renders verbatim.
    declaredMessage = stringify(res.message) ?? stringify(res.error)
  }
  if (declared) return fromDeclared(declared, declaredMessage)

  const d: Draft = {
    template: null,
    company: null,
    order: [],
    values: new Map(),
    states: new Map(),
    status: 'preparing',
    fileName: null,
    downloadUrl: null,
    message: null,
    reportedFilled: null,
    reportedTotal: null
  }

  for (const call of calls) foldToolCall(d, call)

  const fields: ArtifactField[] = d.order.map((key) => ({
    key,
    label: humanise(key),
    value: d.values.get(key) ?? null,
    state: d.states.get(key) ?? 'pending'
  }))

  // Same helper as the declared path: one derivation, so the two paths cannot
  // disagree with each other either.
  const counts = deriveCounts(fields, d.reportedFilled, d.reportedTotal)

  const title =
    d.fileName ??
    (d.template
      ? d.company
        ? `${d.template} — ${d.company}`
        : d.template
      : 'Untitled document')

  return {
    title,
    templateName: d.template,
    companyName: d.company,
    fields,
    status: d.status,
    fileName: d.fileName,
    downloadUrl: d.downloadUrl,
    message: d.message,
    ...counts
  }
}

export function useArtifact(): Artifact | null {
  const messages = useStore((s) => s.messages)
  return useMemo(() => deriveArtifact(messages), [messages])
}
