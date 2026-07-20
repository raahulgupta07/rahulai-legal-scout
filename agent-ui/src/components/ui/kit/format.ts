/** Shared formatters. Dates render identically on every admin screen. */

/** DATE columns reject ""; send null instead. */
export const dateOrNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null)

/** <input type="date"> wants YYYY-MM-DD, not an ISO timestamp. */
export const toDateInput = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : '')

export const formatDate = (v: string | null | undefined) => {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export const formatDateTime = (v: string | null | undefined) => {
  if (!v) return '—'
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Sortable epoch for a date column; null keeps blanks at the bottom. */
export const dateSort = (v: string | null | undefined) => {
  if (!v) return null
  const t = new Date(v).getTime()
  return isNaN(t) ? null : t
}

export const formatBytes = (n: number | null | undefined) => {
  if (!n || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export const formatNumber = (n: number | null | undefined) =>
  typeof n === 'number' && !isNaN(n) ? n.toLocaleString('en-US') : '—'
