/* ------------------------------------------------------------------ *
 * Tool-call display layer.
 *
 * Three layers, each one click deeper:
 *
 *   1. Domain label   — "Read the company register", never `quick_info`.
 *   2. Result summary — a headline plus a handful of labelled facts,
 *                       derived from the tool's REAL payload shape.
 *   3. Raw payload    — the JSON/repr dump, behind an explicit toggle.
 *
 * A lawyer reading the transcript sees layer 1 and 2. Layer 3 exists for the
 * moment something looks wrong. The payloads themselves are unfit to print:
 * `get_company` carries every director with their NRC, `quick_info` measured
 * ~94k characters of trained template metadata. None of that belongs inline.
 *
 * Nothing here may throw: it runs inside render, on data that arrives from
 * the model in whatever shape the tool happened to emit.
 * ------------------------------------------------------------------ */

/** Exact tool name → what actually happened, in the user's language. */
const TOOL_LABELS: Record<string, string> = {
  // Company register
  get_company: 'Read the company register',
  quick_info: 'Read the company register',
  list_companies: 'Read the company register',
  check_company: 'Checked the company record',
  get_directors: 'Read the directors',
  get_shareholders: 'Read the shareholders',

  // Templates
  find_matching_templates: 'Matched templates',
  list_templates: 'Listed the templates',
  get_known_templates: 'Listed the templates',
  list_new_company_setup_templates: 'Listed the setup templates',
  analyze_template: 'Analysed the template',
  analyze_new_template: 'Analysed the template',
  get_template_data: 'Read the template details',
  get_data_for_template: 'Mapped company data to the template',
  save_template_to_knowledge: 'Saved the template analysis',

  // Documents
  generate_document: 'Generated the document',
  create_document: 'Created the document',
  prepare_document: 'Prepared the document',
  preview_document: 'Previewed the document',
  generate_dica_extract: 'Built the DICA extract',
  list_tracked_documents: 'Listed generated documents',
  get_document_info: 'Read the document record',
  get_document_stats: 'Read the document statistics',

  // Knowledge + skills
  search_knowledge: 'Searched the knowledge base',
  lookup_knowledge: 'Searched the knowledge base',
  list_knowledge_sources: 'Listed the knowledge sources',
  load_skill: 'Loaded the corporate-law playbook',
  list_skills: 'Listed the corporate-law playbooks',

  // Interaction
  ask_questions: 'Asked you a question',
  get_clarification_info: 'Clarified the request',

  // Misc
  send_email: 'Sent the email',
  web_search_exa: 'Searched the web',
  read_file: 'Read a file',
  list_files: 'Listed files',
  save_file: 'Saved a file',
  search_content: 'Searched document contents'
}

/** Families of generated tool names — matched only after the exact map misses. */
const TOOL_LABEL_PATTERNS: Array<[RegExp, string]> = [
  [/^lookup_.*candidates$/, 'Looked up people'],
  [/^choose_/, 'Waiting for you to choose'],
  [/^select_/, 'Waiting for you to choose'],
  [/^lookup_/, 'Looked up records']
]

/** snake_case → Sentence case, so the middle layer never leaks a raw name. */
function humanise(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim()
  if (!words) return 'Tool call'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name]
  for (const [pattern, label] of TOOL_LABEL_PATTERNS) {
    if (pattern.test(name)) return label
  }
  return humanise(name)
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * Python literal parser — mirrors `parsePythonLiteral` in
 * components/shell/useArtifact.ts, deliberately duplicated rather than
 * imported so the chat timeline never depends on the document panel.
 *
 * Results from the document tools are JSON today (`_as_json`, smart_doc.py),
 * but sessions stored before that change hold `str(dict)`: single quotes,
 * True/False/None. Regex-rewriting the quotes looks like it works until a
 * value contains an apostrophe or an escape — the `generate_document`
 * preview text contains both — so parse it properly.
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

  return parseValue()
}

/**
 * Tool results reach us as JSON strings from the document tools and as Python
 * reprs from older stored sessions. Try JSON, then the literal parser, and
 * give up quietly rather than throw.
 */
export function parseToolPayload(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    /* fall through to the Python-repr attempt */
  }

  // Only worth attempting on something that looks like a repr of a dict/list.
  if (!/^[[{(]/.test(text)) return null
  try {
    return parsePythonLiteral(text)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Summary model
 * ------------------------------------------------------------------ */

/** `attention` = waiting on the user or nothing found; `error` = it failed. */
export type SummaryTone = 'neutral' | 'attention' | 'error'

export interface ToolFact {
  label: string
  value: string
}

export interface ToolSummary {
  /** One line, safe to print next to the step label. */
  headline: string
  /** A few labelled facts, shown when the step is opened. */
  facts: ToolFact[]
  tone: SummaryTone
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Single-line, whitespace-collapsed, length-capped. Null when there is nothing. */
function text(value: unknown, max = 110): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value !== 'string') return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** `.docx` and underscores are file plumbing, not a document name. */
function prettyDocName(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  return raw.replace(/\.docx$/i, '').replace(/_/g, ' ').trim() || null
}

/**
 * How many things a value represents. Handles the three shapes the Python
 * tools actually emit: a list, a number, and a comma-joined string (the
 * `directors` field of `get_all_companies` is `", ".join(...)`).
 */
function countOf(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (isRecord(value)) return Object.keys(value).length
  if (typeof value === 'string') {
    const flat = value.trim()
    if (!flat) return 0
    return flat.split(',').filter((part) => part.trim()).length
  }
  return null
}

function plural(n: number, singular: string, pluralWord = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralWord}`
}

/** Names out of a list of strings or of records — for an "Includes" fact. */
function nameList(value: unknown, limit = 3): string | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const names: string[] = []
  for (const entry of value) {
    if (names.length >= limit) break
    if (typeof entry === 'string') {
      const t = prettyDocName(entry)
      if (t) names.push(t.slice(0, 48))
      continue
    }
    if (!isRecord(entry)) continue
    const inner = isRecord(entry.data) ? entry.data : entry
    const t =
      text(inner.display_name, 48) ??
      text(inner.company_name, 48) ??
      prettyDocName(inner.name)?.slice(0, 48) ??
      prettyDocName(inner.file_name)?.slice(0, 48) ??
      text(inner.full_name, 48)
    if (t) names.push(t)
  }
  if (names.length === 0) return null
  const extra = value.length - names.length
  return extra > 0 ? `${names.join(', ')} +${extra} more` : names.join(', ')
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
}

/** Facts accumulate through this so an empty/absent value never renders a row. */
function fact(facts: ToolFact[], label: string, value: unknown): void {
  const v = text(value)
  if (v) facts.push({ label, value: v })
}

function factCount(facts: ToolFact[], label: string, value: unknown): void {
  const n = countOf(value)
  if (n !== null && n > 0) facts.push({ label, value: String(n) })
}

/** `4 of 11` — the shape every fill-progress fact takes. */
function progress(filled: unknown, total: unknown): string | null {
  const f = typeof filled === 'number' ? filled : null
  const t = typeof total === 'number' ? total : null
  if (f === null || t === null || t <= 0) return null
  return `${f} of ${t}`
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/* ------------------------------------------------------------------ *
 * Per-tool summarisers
 *
 * Every field name below was read off the Python tool that produces it; the
 * source file and line are cited on each. Guessed keys silently produce a
 * blank fact, which is worse than no fact at all.
 * ------------------------------------------------------------------ */

type Summariser = (data: unknown) => ToolSummary | null

/** scout/tools/knowledge_tools.py:52 — {company, found, data:{…}} */
const summariseGetCompany: Summariser = (data) => {
  if (!isRecord(data)) return null
  const inner = record(data.data)
  const name = text(inner.company_name) ?? text(data.company)

  if (data.found === false) {
    return {
      headline: name ? `No record for ${name}` : 'No matching company',
      facts: [],
      tone: 'attention'
    }
  }

  const facts: ToolFact[] = []
  fact(facts, 'Registration no', inner.registration_number ?? inner.company_registration_number)
  fact(facts, 'Status', inner.status)
  fact(facts, 'Type', inner.company_type)
  factCount(facts, 'Directors', inner.directors)
  factCount(facts, 'Members', inner.shareholders ?? inner.members)
  return { headline: name ?? 'Company record', facts, tone: 'neutral' }
}

/** scout/tools/clarification.py:282 — several found/not-found/ambiguous shapes. */
const summariseCheckCompany: Summariser = (data) => {
  if (!isRecord(data)) return null

  // `company` is a plain name on the numeric/ordinal path and a whole record
  // on the single-suggestion path (clarification.py:337).
  const companyValue = data.company
  const name = isRecord(companyValue)
    ? text(companyValue.company_name) ?? text(companyValue.name)
    : text(companyValue)

  if (data.multiple_matches === true) {
    const matches = Array.isArray(data.matches) ? data.matches : []
    const facts: ToolFact[] = []
    fact(facts, 'Matches', nameList(matches, 4))
    return {
      headline: `${plural(matches.length, 'company', 'companies')} match — needs a choice`,
      facts,
      tone: 'attention'
    }
  }

  if (data.found === false) {
    const facts: ToolFact[] = []
    factCount(facts, 'On file', data.total_count ?? data.available_companies)
    return {
      headline: text(data.message) ?? text(data.error) ?? 'No matching company',
      facts,
      tone: 'attention'
    }
  }

  const inner = isRecord(data.data) ? data.data : isRecord(companyValue) ? companyValue : {}
  const facts: ToolFact[] = []
  fact(facts, 'Registration no', data.registration_no ?? inner.company_registration_number)
  fact(facts, 'Registered office', inner.registered_office)
  factCount(facts, 'Directors', inner.directors)
  return { headline: name ?? 'Company found', facts, tone: 'neutral' }
}

/** scout/tools/clarification.py:48 — {found, matches:[{name, display_name, match_score}], …} */
const summariseFindTemplates: Summariser = (data) => {
  if (!isRecord(data)) return null
  const matches = Array.isArray(data.matches) ? data.matches : []
  const facts: ToolFact[] = []

  if (data.error) {
    return { headline: text(data.error) ?? 'Template lookup failed', facts, tone: 'error' }
  }
  if (matches.length === 0) {
    fact(facts, 'Suggestion', data.suggestion)
    return { headline: 'No matching template', facts, tone: 'attention' }
  }

  const best = record(matches[0])
  const bestName = prettyDocName(best.display_name ?? best.name)

  if (matches.length === 1 || data.selected_template) {
    fact(facts, 'Template', prettyDocName(data.selected_template) ?? bestName)
    return { headline: bestName ?? '1 template matched', facts, tone: 'neutral' }
  }

  fact(facts, 'Candidates', nameList(matches, 4))
  return {
    headline: `${matches.length} templates matched — needs a choice`,
    facts,
    tone: data.clarification_needed ? 'attention' : 'neutral'
  }
}

/**
 * scout/tools/fast_info.py:287 — one of four shapes depending on `info_type`.
 * The sections are `{total, templates|companies:[…], …}`; the `documents`
 * variant returns that section at the top level (fast_info.py:253).
 */
const summariseQuickInfo: Summariser = (data) => {
  if (!isRecord(data)) return null

  const section = (value: unknown, listKey: string): number | null => {
    if (Array.isArray(value)) return value.length
    if (!isRecord(value)) return null
    if (typeof value.total === 'number') return value.total
    const list = value[listKey]
    return Array.isArray(list) ? list.length : null
  }

  const templates = section(data.templates, 'templates')
  const companies = section(data.companies, 'companies')
  // The documents-only shape IS the section, at the top level — and its
  // `documents` list is truncated to 10 (fast_info.py:259), so the real count
  // is the sibling `total`, never the list length.
  const documents =
    Array.isArray(data.documents) && typeof data.total === 'number'
      ? data.total
      : section(data.documents, 'documents')

  const facts: ToolFact[] = []
  if (templates !== null) facts.push({ label: 'Templates', value: String(templates) })
  if (companies !== null) facts.push({ label: 'Companies', value: String(companies) })
  if (documents !== null) facts.push({ label: 'Documents', value: String(documents) })

  const parts: string[] = []
  if (templates !== null) parts.push(plural(templates, 'template'))
  if (companies !== null) parts.push(plural(companies, 'company', 'companies'))
  if (documents !== null) parts.push(plural(documents, 'document'))

  if (parts.length === 0) return null
  return { headline: parts.join(' · '), facts, tone: 'neutral' }
}

/** scout/tools/clarification.py:175 — {available, companies:[{company_name,…}], total} */
const summariseListCompanies: Summariser = (data) => {
  if (!isRecord(data)) return null
  const companies = Array.isArray(data.companies) ? data.companies : []
  if (data.available === false && companies.length === 0) {
    return { headline: text(data.error) ?? 'No companies on file', facts: [], tone: 'attention' }
  }
  const total = typeof data.total === 'number' ? data.total : companies.length
  const facts: ToolFact[] = []
  fact(facts, 'Includes', nameList(companies))
  return { headline: plural(total, 'company', 'companies'), facts, tone: 'neutral' }
}

/**
 * scout/tools/template_analyzer.py:628 → list_analyzed_templates() (line 500),
 * and scout/tools/clarification.py:375 which adds `count`.
 */
const summariseListTemplates: Summariser = (data) => {
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.templates)
      ? data.templates
      : null
  if (list === null) return null
  const total = isRecord(data) && typeof data.count === 'number' ? data.count : list.length
  if (total === 0) {
    const message = isRecord(data) ? text(data.message) : null
    return { headline: message ?? 'No templates on file', facts: [], tone: 'attention' }
  }
  const facts: ToolFact[] = []
  fact(facts, 'Includes', nameList(list))
  return { headline: plural(total, 'template'), facts, tone: 'neutral' }
}

/**
 * scout/tools/smart_doc.py:653 (generate) — success carries `file_name` +
 * `validation_summary` + `document_state`; the two "not yet" shapes are
 * `unresolved_slots` (line 645) and `user_input_fields` (line 741), both of
 * which set success=False while meaning "waiting on the user", not "failed".
 */
const summariseGenerate: Summariser = (data) => {
  if (!isRecord(data)) return null
  const state = record(data.document_state)
  const validation = record(data.validation_summary)

  if (data.success === true) {
    // The generated name carries a timestamp, so it reads badly as a headline;
    // the template is what the user asked for. The file name stays as a fact.
    const template = prettyDocName(state.template)
    const facts: ToolFact[] = []
    fact(facts, 'Company', state.company)
    fact(
      facts,
      'Fields filled',
      progress(validation.filled_from_data, validation.total_placeholders) ??
        progress(state.filled, state.total)
    )
    const unfilled = countOf(validation.unfilled ?? validation.unfilled_fields)
    if (unfilled) facts.push({ label: 'Left blank', value: String(unfilled) })
    fact(facts, 'File', data.file_name ?? state.file_name)
    return {
      headline: template ?? prettyDocName(data.file_name) ?? 'Document generated',
      facts,
      tone: unfilled ? 'attention' : 'neutral'
    }
  }

  const outstanding = [...strings(data.unresolved_slots), ...strings(data.user_input_fields)]
  if (outstanding.length > 0 || state.status === 'awaiting-input') {
    const facts: ToolFact[] = []
    fact(facts, 'Company', state.company)
    fact(facts, 'Template', prettyDocName(state.template))
    fact(facts, 'Still needed', nameList(outstanding, 4))
    return {
      headline: text(data.message) ?? 'Waiting on your input',
      facts,
      tone: 'attention'
    }
  }

  return {
    headline: text(data.error) ?? text(data.message) ?? 'Could not generate the document',
    facts: [],
    tone: 'error'
  }
}

/** scout/tools/smart_doc.py:476 — prepare_document_data's return. */
const summarisePrepare: Summariser = (data) => {
  if (!isRecord(data)) return null
  if (data.success === false) {
    return { headline: text(data.error) ?? 'Could not prepare the document', facts: [], tone: 'error' }
  }

  const state = record(data.document_state)
  const analysis = record(data.template_analysis)
  const validation = record(data.validation)
  const ready = data.ready_to_generate === true

  const facts: ToolFact[] = []
  fact(facts, 'Template', prettyDocName(analysis.template ?? state.template))
  fact(facts, 'Company', state.company)
  fact(facts, 'Fields ready', progress(state.filled, state.total ?? analysis.total_fields))
  factCount(facts, 'Missing fields', validation.missing_fields)
  factCount(facts, 'Parties to choose', data.unresolved_slots)

  return {
    headline: ready ? 'Ready to generate' : text(data.message) ?? 'Waiting on your input',
    facts,
    tone: ready ? 'neutral' : 'attention'
  }
}

/** scout/tools/smart_doc.py:1054 — {preview, template_name, field_coverage, …} */
const summarisePreview: Summariser = (data) => {
  if (!isRecord(data)) return null
  if (data.success === false) {
    return { headline: text(data.error) ?? 'Could not build the preview', facts: [], tone: 'error' }
  }

  const matched = countOf(data.matched_fields) ?? 0
  const missing = countOf(data.missing_fields) ?? 0
  const facts: ToolFact[] = []
  fact(facts, 'Company', data.company_name)
  fact(facts, 'Coverage', data.field_coverage)
  fact(facts, 'Fields matched', progress(matched, matched + missing))
  if (missing) facts.push({ label: 'Missing', value: String(missing) })

  return {
    headline: prettyDocName(data.template_name) ?? 'Preview ready',
    facts,
    tone: missing ? 'attention' : 'neutral'
  }
}

/** scout/tools/smart_doc.py:320 → extract_placeholders_from_template (line 161). */
const summariseAnalyzeTemplate: Summariser = (data) => {
  if (!isRecord(data)) return null
  if (data.success === false) {
    return { headline: text(data.error) ?? 'Template not found', facts: [], tone: 'error' }
  }
  const facts: ToolFact[] = []
  fact(facts, 'Placeholders', data.total_placeholders ?? countOf(data.fields))
  return {
    headline: prettyDocName(data.template) ?? 'Template analysed',
    facts,
    tone: 'neutral'
  }
}

/**
 * scout/tools/people_picker.py:334 — `_payload()` (line 279):
 * {picker, purpose, company:{name}, multi_select, candidates:[…], note}.
 */
const summarisePickerLookup: Summariser = (data) => {
  if (!isRecord(data)) return null
  if (data.error) {
    return { headline: text(data.error) ?? 'Lookup failed', facts: [], tone: 'error' }
  }
  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  const company = record(data.company)
  const facts: ToolFact[] = []
  fact(facts, 'For', company.name)
  fact(facts, 'Purpose', data.purpose)
  fact(facts, 'Includes', nameList(candidates, 4))
  if (data.multi_select === true) facts.push({ label: 'Selection', value: 'more than one allowed' })
  fact(facts, 'Note', data.note)

  return {
    headline: candidates.length ? plural(candidates.length, 'candidate') : 'No one on the register',
    facts,
    tone: candidates.length ? 'neutral' : 'attention'
  }
}

/** scout/tools/people_picker.py:605 — {picker, selected, count, status, chosen_names}. */
const summarisePickerChoice: Summariser = (data) => {
  if (!isRecord(data)) return null
  const names = strings(data.chosen_names)
  if (data.status === 'confirmed' && names.length) {
    const facts: ToolFact[] = []
    if (names.length > 1) facts.push({ label: 'Chosen', value: String(names.length) })
    return { headline: text(names.join(', ')) ?? 'Choice recorded', facts, tone: 'neutral' }
  }
  return { headline: 'Waiting for you to choose', facts: [], tone: 'attention' }
}

/** scout/tools/knowledge_tools.py:24 and :38 — {query|key, results, count}. */
const summariseKnowledgeSearch: Summariser = (data) => {
  if (!isRecord(data)) return null
  const count = typeof data.count === 'number' ? data.count : countOf(data.results) ?? 0
  const facts: ToolFact[] = []
  fact(facts, 'Query', data.query ?? data.value)
  fact(facts, 'Field', data.key)
  return {
    headline: count ? plural(count, 'result') : 'nothing found',
    facts,
    tone: count ? 'neutral' : 'attention'
  }
}

/** scout/tools/legal_skills.py:62 — {success, name, description, version, body}. */
const summariseLoadSkill: Summariser = (data) => {
  if (!isRecord(data)) return null
  if (data.success === false) {
    const facts: ToolFact[] = []
    factCount(facts, 'Available', data.available_skills)
    return { headline: text(data.error) ?? 'Playbook not found', facts, tone: 'error' }
  }
  const facts: ToolFact[] = []
  fact(facts, 'Covers', data.description)
  fact(facts, 'Version', data.version)
  return { headline: text(data.name) ?? 'Playbook loaded', facts, tone: 'neutral' }
}

/** scout/tools/legal_skills.py:24 — {skills: "name — description\n…", count}. */
const summariseListSkills: Summariser = (data) => {
  if (!isRecord(data)) return null
  const count = typeof data.count === 'number' ? data.count : 0
  return {
    headline: count ? plural(count, 'playbook') : 'No playbooks available',
    facts: [],
    tone: count ? 'neutral' : 'attention'
  }
}

/** scout/tools/knowledge_tools.py:95 and :114 — [{company, data:{…}}]. */
function summariseParty(noun: string): Summariser {
  return (data) => {
    if (!Array.isArray(data)) return null
    if (data.length === 0) {
      return { headline: `No ${noun}s on file`, facts: [], tone: 'attention' }
    }
    const facts: ToolFact[] = []
    fact(facts, 'Company', record(data[0]).company)
    fact(facts, 'Includes', nameList(data, 4))
    return { headline: plural(data.length, noun), facts, tone: 'neutral' }
  }
}

/** scout/tools/document_tracker.py:217 — {documents: [...]}. */
const summariseListDocuments: Summariser = (data) => {
  if (!isRecord(data)) return null
  const docs = Array.isArray(data.documents) ? data.documents : []
  const facts: ToolFact[] = []
  fact(facts, 'Includes', nameList(docs))
  return {
    headline: docs.length ? plural(docs.length, 'document') : 'No documents generated yet',
    facts,
    tone: docs.length ? 'neutral' : 'attention'
  }
}

/** scout/tools/document_tracker.py:221 — {document: {...}} or {error}. */
const summariseDocumentInfo: Summariser = (data) => {
  if (!isRecord(data)) return null
  if (data.error) return { headline: text(data.error) ?? 'Not found', facts: [], tone: 'attention' }
  const doc = record(data.document)
  const facts: ToolFact[] = []
  fact(facts, 'Company', doc.company_name)
  fact(facts, 'Template', prettyDocName(doc.template_name))
  fact(facts, 'Version', doc.version)
  fact(facts, 'Created', doc.created_at)
  return { headline: prettyDocName(doc.file_name) ?? 'Document record', facts, tone: 'neutral' }
}

/** scout/tools/document_tracker.py:195 — {total_documents, by_company, by_template, …}. */
const summariseDocumentStats: Summariser = (data) => {
  if (!isRecord(data)) return null
  const total = typeof data.total_documents === 'number' ? data.total_documents : null
  if (total === null) return null
  const facts: ToolFact[] = []
  factCount(facts, 'Companies', data.by_company)
  factCount(facts, 'Templates used', data.by_template)
  return { headline: plural(total, 'document'), facts, tone: 'neutral' }
}

/** scout/tools/knowledge_tools.py:170 — {company_name, company_info, directors, shareholders}. */
const summariseDataForTemplate: Summariser = (data) => {
  if (!isRecord(data)) return null
  const facts: ToolFact[] = []
  factCount(facts, 'Directors', data.directors)
  factCount(facts, 'Shareholders', data.shareholders)
  if (!data.company_info) facts.push({ label: 'Company record', value: 'not found' })
  return {
    headline: text(data.company_name) ?? 'Company data mapped',
    facts,
    tone: data.company_info ? 'neutral' : 'attention'
  }
}

/** scout/tools/knowledge_tools.py:133 — {template, required_fields, matched_data}. */
const summariseTemplateData: Summariser = (data) => {
  if (!isRecord(data)) return null
  const required = countOf(data.required_fields)
  if (required === null) return null
  const facts: ToolFact[] = []
  facts.push({ label: 'Required fields', value: String(required) })
  factCount(facts, 'With data', data.matched_data)
  return {
    headline: prettyDocName(data.template) ?? 'Template details',
    facts,
    tone: 'neutral'
  }
}

/** scout/tools/clarification.py:262 — {templates: [...], companies: [...], message}. */
const summariseClarificationInfo: Summariser = (data) => {
  if (!isRecord(data)) return null
  const templates = countOf(data.templates)
  const companies = countOf(data.companies)
  if (templates === null && companies === null) return null
  const facts: ToolFact[] = []
  if (templates !== null) facts.push({ label: 'Templates', value: String(templates) })
  if (companies !== null) facts.push({ label: 'Companies', value: String(companies) })
  return {
    headline: [
      templates !== null ? plural(templates, 'template') : null,
      companies !== null ? plural(companies, 'company', 'companies') : null
    ]
      .filter(Boolean)
      .join(' · '),
    facts,
    tone: 'neutral'
  }
}

/** scout/tools/knowledge_tools.py:165 — a plain list of filenames. */
const summariseKnowledgeSources: Summariser = (data) => {
  if (!Array.isArray(data)) return null
  const facts: ToolFact[] = []
  fact(facts, 'Includes', nameList(data))
  return {
    headline: data.length ? plural(data.length, 'source') : 'No knowledge sources',
    facts,
    tone: data.length ? 'neutral' : 'attention'
  }
}

const SUMMARISERS: Record<string, Summariser> = {
  get_company: summariseGetCompany,
  check_company: summariseCheckCompany,
  find_matching_templates: summariseFindTemplates,
  quick_info: summariseQuickInfo,
  list_companies: summariseListCompanies,
  list_all_companies: summariseListCompanies, // registered under its __name__ in agent.py
  list_templates: summariseListTemplates,
  get_known_templates: summariseListTemplates,
  list_new_company_setup_templates: summariseListTemplates,
  generate_document: summariseGenerate,
  create_document: summariseGenerate,
  prepare_document: summarisePrepare,
  preview_document: summarisePreview,
  analyze_template: summariseAnalyzeTemplate,
  analyze_new_template: summariseAnalyzeTemplate,
  search_knowledge: summariseKnowledgeSearch,
  lookup_knowledge: summariseKnowledgeSearch,
  list_knowledge_sources: summariseKnowledgeSources,
  load_skill: summariseLoadSkill,
  list_skills: summariseListSkills,
  get_directors: summariseParty('director'),
  get_shareholders: summariseParty('shareholder'),
  list_tracked_documents: summariseListDocuments,
  get_document_info: summariseDocumentInfo,
  get_document_stats: summariseDocumentStats,
  get_data_for_template: summariseDataForTemplate,
  get_template_data: summariseTemplateData,
  get_clarification_info: summariseClarificationInfo
}

const SUMMARISER_PATTERNS: Array<[RegExp, Summariser]> = [
  [/^lookup_.*candidates$/, summarisePickerLookup],
  [/^choose_/, summarisePickerChoice],
  [/^select_/, summarisePickerChoice]
]

/* ------------------------------------------------------------------ *
 * Fallback
 * ------------------------------------------------------------------ */

/**
 * The safety property: an unmapped tool degrades to ONE line, never to the
 * payload. A tool added later cannot regress this view to a JSON wall — the
 * worst it can do is say "returned 9 fields".
 */
function fallbackSummary(data: unknown, raw: unknown): ToolSummary {
  if (Array.isArray(data)) {
    return {
      headline: data.length ? `returned ${plural(data.length, 'item')}` : 'returned nothing',
      facts: [],
      tone: data.length ? 'neutral' : 'attention'
    }
  }

  if (isRecord(data)) {
    if (data.error) {
      return { headline: text(data.error) ?? 'failed', facts: [], tone: 'error' }
    }
    if (data.success === false) {
      return { headline: text(data.message) ?? 'failed', facts: [], tone: 'error' }
    }
    // A short, human `message` is the tool telling us what happened — better
    // than a key count, and still one line.
    const message = text(data.message, 90)
    const keys = Object.keys(data).length
    return {
      headline: message ?? (keys ? `returned ${plural(keys, 'field')}` : 'returned nothing'),
      facts: [],
      tone: 'neutral'
    }
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return { headline: String(data), facts: [], tone: 'neutral' }
  }

  // Unparseable, or a bare string. A one-line clip is a summary; the whole
  // thing stays behind the raw toggle.
  const flat = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!flat) return { headline: 'no output', facts: [], tone: 'neutral' }
  if (flat.length <= 90) return { headline: flat, facts: [], tone: 'neutral' }
  return { headline: `returned ${flat.length} characters of text`, facts: [], tone: 'neutral' }
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Always returns a summary — never null, never the raw payload. A summariser
 * that does not recognise its own payload returns null and falls through to
 * the generic one, so a shape change downgrades the row rather than breaking
 * it. The whole dispatch is wrapped: this runs in render.
 */
export function summariseToolCall(toolName: string, raw: unknown): ToolSummary {
  let data: unknown = null
  try {
    data = parseToolPayload(raw)
  } catch {
    data = null
  }

  try {
    let summariser: Summariser | undefined = SUMMARISERS[toolName]
    if (!summariser) {
      for (const [pattern, fn] of SUMMARISER_PATTERNS) {
        if (pattern.test(toolName)) {
          summariser = fn
          break
        }
      }
    }
    if (summariser && data != null) {
      const summary = summariser(data)
      if (summary && summary.headline) return summary
    }
  } catch {
    /* a summariser must never take the transcript down with it */
  }

  return fallbackSummary(data, raw)
}

/** Pretty-print args/result for the raw layer without ever throwing. */
export function formatRaw(raw: unknown): string | null {
  if (raw == null) return null
  try {
    const parsed = parseToolPayload(raw)
    if (parsed != null) {
      // An empty args object is noise in the deep dive — show nothing.
      if (isRecord(parsed) && Object.keys(parsed).length === 0) return null
      if (Array.isArray(parsed) && parsed.length === 0) return null
      return JSON.stringify(parsed, null, 2)
    }
    if (typeof raw === 'string') return raw.trim() || null
    return String(raw)
  } catch {
    return typeof raw === 'string' ? raw : null
  }
}
