/**
 * A short name for a chat, derived from what the chat is actually about.
 *
 * Agno names a session after the user's literal first message, so the sidebar
 * fills with truncated half-sentences — "Prepare the Corporate Shareholder
 * Consent - Directors Resolution for CITY HOLDINGS LIMITED. New company GOLDEN
 * DELTA…" — and, per the comment on AGENTOS_PROTECTED_ROOTS in app/main.py,
 * with real company and director names.
 *
 * Open WebUI solves this by asking a task model to write a 2-4 word title. We
 * do not need to: by the time the first document tool runs we already KNOW the
 * template and the company as structured data. Deriving the title costs no
 * tokens, adds no latency, cannot hallucinate, and cannot fail — so the model
 * is not involved at all. Chats that never touch a document keep the message
 * as their name, which for a one-line question is already the right title.
 */

interface TitleSource {
  tool_name?: string | null
  tool_args?: Record<string, unknown> | null
}

/** Tools whose args name a template and a company, best evidence first. */
const DOCUMENT_TOOLS = [
  'generate_document',
  'preview_doc',
  'prepare_document',
  'analyze_template'
]

/** "CITY HOLDINGS LIMITED" → "City Holdings". */
export function shortCompany(raw: string): string {
  const cleaned = raw
    .replace(/\([^)]*\)/g, ' ')            // drop "(Registration No: ...)"
    .replace(/\b(LIMITED|LTD\.?|CO\.?|COMPANY|PUBLIC|PRIVATE|PTE)\b/gi, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  return cleaned
    .split(' ')
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toUpperCase()))
    .join(' ')
}

/**
 * "Corporate Shareholder Consent - Directors Resolution for New Company Setup
 * and Director Appointment.docx" → "Corporate Shareholder Consent".
 *
 * Templates in this library are named `<subject> - <variant> for <purpose>`,
 * so the subject is everything before the first separator. That is the part a
 * person would say out loud.
 */
export function shortTemplate(raw: string): string {
  const stem = raw.replace(/\.docx$/i, '').replace(/_/g, ' ')
  const subject = stem.split(/\s+-\s+| for /i)[0].replace(/\s+/g, ' ').trim()
  if (!subject) return ''
  // Four words is the ceiling: past that it stops being a label and starts
  // being the sentence we were trying to escape.
  const words = subject.split(' ')
  return words.length > 4 ? words.slice(0, 4).join(' ') : subject
}

/**
 * Returns a title, or null when the run carries no document evidence — the
 * caller must then leave the existing name alone rather than invent one.
 */
export function deriveSessionTitle(tools: ReadonlyArray<TitleSource>): string | null {
  for (const name of DOCUMENT_TOOLS) {
    for (const tool of tools) {
      if (tool?.tool_name !== name) continue
      const args = tool.tool_args ?? {}
      const template = typeof args.template_name === 'string' ? args.template_name : ''
      const company = typeof args.company_name === 'string' ? args.company_name : ''
      const t = shortTemplate(template)
      const c = shortCompany(company)
      if (t && c) return `${t} · ${c}`
      if (t) return t
      // A company with no template is not yet a document — keep looking rather
      // than naming the chat after a lookup that may go nowhere.
    }
  }
  return null
}
