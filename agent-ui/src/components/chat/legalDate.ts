/**
 * Dates asked for in a question card.
 *
 * A native `<input type="date">` speaks ISO — `2026-06-30`. These documents do
 * not: a Myanmar resignation letter reads "30 June 2026". Nothing on the server
 * normalises a date (smart_doc.py has no date handling at all), so whatever the
 * card sends is what lands in the .docx, verbatim. The conversion therefore has
 * to happen here, before the answer leaves the card.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Today in the viewer's LOCAL calendar, as the ISO string the input wants. */
export const todayISO = (): string => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  // Deliberately not toISOString() — that is UTC, and a user at UTC+06:30
  // before 06:30 local would get yesterday's date on a legal document.
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * `2026-06-30` → `30 June 2026`. Anything that is not an ISO date passes
 * through untouched, so a hand-typed answer is never mangled.
 */
export const formatLegalDate = (value: string): string => {
  const m = ISO_RE.exec((value ?? '').trim())
  if (!m) return value
  const [, y, mo, d] = m
  const monthIndex = Number(mo) - 1
  if (monthIndex < 0 || monthIndex > 11) return value
  return `${Number(d)} ${MONTHS[monthIndex]} ${Number(y)}`
}

// A question is a date question when the model says so. That is the only
// authoritative signal — but the model does not always set it, and the prompt
// change ships with an image that may lag the frontend. So a narrow textual
// fallback exists too, and the card always offers "Type instead" to escape it.
//
// The boundaries are (?<![a-z]) / (?![a-z]) rather than \b, because the model
// names fields with underscores — \bdate\b never fires inside
// "resignation_date", since "_" is a word character. These boundaries still
// exclude the words that merely CONTAIN "date": update, candidate, mandate,
// validated — in each the letter before "date" is a-z.
const DATE_WORD_RE = /(?<![a-z])dates?(?![a-z])|\bd\.o\.b\b|(?<![a-z])deadlines?(?![a-z])/i

// Guards against a compound ask — "Meeting date and location?" — where a date
// picker would silently drop half the question.
const COMPOUND_RE = /\b(?:and|,|\/|plus|as well as)\b/i

export const looksLikeDateQuestion = (text: string, id: string): boolean => {
  const t = `${id} ${text}`
  if (!DATE_WORD_RE.test(t)) return false
  return !COMPOUND_RE.test(text)
}
