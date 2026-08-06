'use client'

/**
 * Fill-in view — the whole document with its blanks shown in place.
 *
 * The legal team asked to see the entire document and fill each missing field
 * by choosing from what we already hold, rather than typing blind into a card.
 * This renders the template inline: settled fields read as normal text, blanks
 * are buttons that open a small picker of register candidates (plus free text).
 * "Generate" sends the chosen values straight to the document generator.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Check, ChevronDown, Loader2, Download, FileText } from 'lucide-react'

const DocViewer = dynamic(() => import('@/components/ui/DocViewer'), { ssr: false })

const API_BASE = process.env.NEXT_PUBLIC_API_URL || ''

function authToken() {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem('ls_token') || ''
  } catch {
    return ''
  }
}

interface Candidate {
  label: string
  value: string
  source: string
}
interface Blank {
  type: 'blank'
  key: string
  label: string
  value: string | null
  filled: boolean
  kind: string
  candidates: Candidate[]
}
interface ParaStyle {
  align?: 'left' | 'center' | 'right' | 'justify' | null
  bold?: boolean
  italic?: boolean
  underline?: boolean
  heading?: number
  list?: 'bullet' | 'number' | null
  indent?: number
  empty?: boolean
}
type Block =
  | { type: 'text'; text: string }
  | { type: 'break' }
  | ({ type: 'para_start' } & ParaStyle)
  | { type: 'para_end' }
  | { type: 'table_start'; columns: number }
  | { type: 'table_end' }
  | { type: 'row_start' }
  | { type: 'row_end' }
  | { type: 'cell_start' }
  | { type: 'cell_end' }
  | Blank

interface FillView {
  success: boolean
  error?: string
  blocks: Block[]
  blanks: Blank[]
  total_blanks: number
  outstanding: number
}

interface RenderCtx {
  valueFor: (b: Blank) => string | null
  openKey: string | null
  setOpenKey: (k: string | null) => void
  choose: (key: string, value: string) => void
}

/**
 * Walk the flat block stream into real document structure.
 *
 * The backend emits paragraph and table boundaries as markers rather than a
 * nested tree, because the blanks have to stay addressable by index. This
 * rebuilds the nesting on the way in: paragraphs collect their inline runs,
 * cells collect paragraphs, rows collect cells.
 */
function renderDocument(blocks: Block[], ctx: RenderCtx) {
  const out: React.ReactNode[] = []
  let i = 0

  const inline = (stop: Block['type'][]): React.ReactNode[] => {
    const nodes: React.ReactNode[] = []
    while (i < blocks.length && !stop.includes(blocks[i].type)) {
      const blk = blocks[i]
      const at = i
      i += 1
      if (blk.type === 'text') {
        nodes.push(<span key={at}>{blk.text}</span>)
      } else if (blk.type === 'break') {
        nodes.push(<br key={at} />)
      } else if (blk.type === 'blank') {
        const id = blk.key + ':' + at
        nodes.push(
          <BlankChip
            key={at}
            blank={blk}
            value={ctx.valueFor(blk)}
            open={ctx.openKey === id}
            onToggle={() => ctx.setOpenKey(ctx.openKey === id ? null : id)}
            onChoose={(v) => ctx.choose(blk.key, v)}
          />
        )
      }
    }
    return nodes
  }

  const paragraph = (key: number) => {
    const style = blocks[i] as { type: 'para_start' } & ParaStyle
    i += 1
    const kids = inline(['para_end'])
    if (blocks[i]?.type === 'para_end') i += 1

    // An empty paragraph is vertical space in Word; keep it, or the document
    // collapses into one dense block and stops looking like the original.
    if (style.empty) return <div key={key} className="h-[0.85em]" />

    const cls = [
      'my-[0.35em]',
      style.align === 'center' ? 'text-center' : '',
      style.align === 'right' ? 'text-right' : '',
      style.align === 'justify' ? 'text-justify' : '',
      style.bold ? 'font-semibold' : '',
      style.italic ? 'italic' : '',
      style.underline ? 'underline' : '',
      style.heading ? 'mt-[1.1em] mb-[0.5em] font-semibold' : ''
    ]
      .filter(Boolean)
      .join(' ')

    const size = style.heading === 1 ? '1.12em' : style.heading ? '1.05em' : undefined
    return (
      <p
        key={key}
        className={cls}
        style={{
          marginLeft: style.indent ? `${style.indent * 1.6}em` : undefined,
          fontSize: size
        }}
      >
        {kids}
      </p>
    )
  }

  const table = (key: number) => {
    i += 1 // table_start
    const rows: React.ReactNode[] = []
    while (i < blocks.length && blocks[i].type !== 'table_end') {
      if (blocks[i].type !== 'row_start') {
        i += 1
        continue
      }
      i += 1 // row_start
      const cells: React.ReactNode[] = []
      while (i < blocks.length && blocks[i].type !== 'row_end') {
        if (blocks[i].type !== 'cell_start') {
          i += 1
          continue
        }
        i += 1 // cell_start
        const kids: React.ReactNode[] = []
        while (i < blocks.length && blocks[i].type !== 'cell_end') {
          if (blocks[i].type === 'para_start') kids.push(paragraph(i))
          else i += 1
        }
        if (blocks[i]?.type === 'cell_end') i += 1
        cells.push(
          <td key={cells.length} className="border border-neutral-300 px-2 py-1 align-top">
            {kids}
          </td>
        )
      }
      if (blocks[i]?.type === 'row_end') i += 1
      rows.push(<tr key={rows.length}>{cells}</tr>)
    }
    if (blocks[i]?.type === 'table_end') i += 1
    return (
      <div key={key} className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-[0.95em]">
          <tbody>{rows}</tbody>
        </table>
      </div>
    )
  }

  while (i < blocks.length) {
    const at = i
    const kind = blocks[i].type
    if (kind === 'para_start') out.push(paragraph(at))
    else if (kind === 'table_start') out.push(table(at))
    else i += 1
  }
  return out
}

export default function FillInView({
  templateName,
  companyName,
  knownFields = []
}: {
  templateName: string | null
  companyName: string | null
  /** Values the chat has already settled, keyed by placeholder. */
  knownFields?: { key: string; value: string | null }[]
}) {
  const [data, setData] = useState<FillView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A failed generate must NOT be treated like a failed load: the document and
  // every value the user already picked stay on screen, with the reason shown
  // as a banner above the toolbar.
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<{ file_name: string; download_url: string } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!templateName || !companyName) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const tok = authToken()
      const res = await fetch(
        `${API_BASE}/api/documents/fill-view?template=${encodeURIComponent(
          templateName
        )}&company=${encodeURIComponent(companyName)}`,
        { headers: { Authorization: `Bearer ${tok}` } }
      )
      const json = (await res.json()) as FillView
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load document')
      setData(json)
      setPicks({})
    } catch (e: any) {
      setError(e?.message || 'Failed to load document')
    } finally {
      setLoading(false)
    }
  }, [templateName, companyName])

  useEffect(() => {
    load()
  }, [load])

  // close the picker on outside click
  useEffect(() => {
    if (!openKey) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenKey(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openKey])

  /**
   * What the conversation has already established, keyed by placeholder.
   * Rebuilt on every render because the chat keeps streaming answers in while
   * this panel is open.
   */
  const fromChat = useMemo(() => {
    const map: Record<string, string> = {}
    for (const f of knownFields) {
      const v = (f.value ?? '').trim()
      if (f.key && v) map[f.key] = v
    }
    return map
  }, [knownFields])

  /**
   * Precedence: an edit made HERE beats the chat, which beats whatever the
   * register resolved. The user's most recent, most specific action wins.
   */
  const valueFor = (b: Blank): string | null =>
    picks[b.key] ?? fromChat[b.key] ?? b.value

  const outstanding = useMemo(() => {
    if (!data) return 0
    return data.blanks.filter(
      (b) => !((picks[b.key] ?? fromChat[b.key] ?? b.value)?.trim())
    ).length
  }, [data, picks, fromChat])

  const choose = (key: string, value: string) => {
    setPicks((p) => ({ ...p, [key]: value }))
    setOpenKey(null)
  }

  const generate = async () => {
    if (!templateName || !companyName) return
    setGenerating(true)
    setGenerateError(null)
    try {
      const tok = authToken()
      const res = await fetch(`${API_BASE}/api/documents/fill-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        // Send the chat's answers too, not just what was typed in this panel —
        // otherwise generating from here silently discards them.
        body: JSON.stringify({
          template: templateName,
          company: companyName,
          custom_data: { ...fromChat, ...picks }
        })
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        // The backend returns both a plain-English `message` and an internal
        // `error` code. Only the former is fit to show a lawyer.
        throw new Error(json.message || json.error || 'Generation failed')
      }
      setResult({ file_name: json.file_name, download_url: json.download_url })
    } catch (e: any) {
      setGenerateError(e?.message || 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  if (!templateName || !companyName) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-sm text-[var(--faint,#9CA3AF)]">
          Pick a template and company first — the document appears here with its blanks to fill.
        </p>
      </div>
    )
  }

  if (result) {
    const tok = authToken()
    const previewUrl = `${API_BASE}/api/documents/preview-pdf/${encodeURIComponent(
      result.file_name
    )}?token=${encodeURIComponent(tok)}`
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ok-strong,#15803d)]">
            <Check className="h-4 w-4" /> Document generated
          </span>
          <div className="flex items-center gap-1">
            <a
              href={`${API_BASE}${result.download_url.startsWith('/') ? '' : '/'}${result.download_url}`}
              download={result.file_name}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-blue-600 hover:bg-[var(--accent)] dark:text-blue-400"
            >
              <Download className="h-3.5 w-3.5" /> Download
            </a>
            <button
              type="button"
              onClick={() => setResult(null)}
              className="rounded px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-[var(--text)]"
            >
              Back to fill
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <DocViewer url={previewUrl} forceFormat="pdf" className="h-full" />
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--faint,#9CA3AF)]" />
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <FileText className="h-6 w-6 text-[var(--faint,#9CA3AF)]" />
          <p className="text-sm text-[var(--danger-strong,#b91c1c)]">{error}</p>
          <button
            type="button"
            onClick={load}
            className="rounded px-2 py-1 text-xs font-medium text-blue-600 hover:bg-[var(--accent)]"
          >
            Retry
          </button>
        </div>
      ) : data ? (
        <>
          {/* The document, laid out as the Word file lays it out — a page with
              margins, centred titles, bold headings and real tables. Lawyers
              proof-read shape as much as wording, so a flat text stream with
              chips in it was the wrong shape to review. */}
          <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg-secondary)] px-4 py-5">
            {/* Fixed white page with serif type, independent of the app theme:
                this is a preview of a printed legal document, not a UI surface,
                and it must read the same in light and dark mode. */}
            <div
              className="mx-auto max-w-[52rem] rounded-[3px] border border-[var(--border)] bg-white px-[3.2rem] py-[3rem] text-[#111] shadow-sm"
              style={{
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontSize: '13.5px',
                lineHeight: 1.75
              }}
            >
              {renderDocument(data.blocks, {
                valueFor,
                openKey,
                setOpenKey,
                choose
              })}
            </div>
          </div>

          {generateError && (
            <div className="flex flex-shrink-0 items-start gap-2 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] px-4 py-2.5">
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warn)]" />
              <p className="text-xs text-[var(--text)]">
                {generateError}
                <button
                  type="button"
                  onClick={() => setGenerateError(null)}
                  className="ml-2 font-medium text-[var(--brand)] hover:underline"
                >
                  Dismiss
                </button>
              </p>
            </div>
          )}

          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5">
            <span className="text-xs text-[var(--text-secondary)]">
              {outstanding > 0 ? (
                <>
                  <span className="font-semibold text-[var(--warn)]">{outstanding}</span> blank
                  {outstanding === 1 ? '' : 's'} left — you can generate now and fill the rest later
                </>
              ) : (
                'All blanks filled'
              )}
            </span>
            <button
              type="button"
              onClick={generate}
              disabled={generating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {generating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Generate document
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

function BlankChip({
  blank,
  value,
  open,
  onToggle,
  onChoose
}: {
  blank: Blank
  value: string | null
  open: boolean
  onToggle: () => void
  onChoose: (value: string) => void
}) {
  const [freeText, setFreeText] = useState('')
  const settled = !!value?.trim()
  return (
    <span className="relative inline-block align-baseline">
      <button
        type="button"
        onClick={onToggle}
        title={blank.label}
        // Literal colours, not theme tokens: these sit on the fixed white page
        // and must stay legible when the surrounding app is in dark mode.
        // A settled value reads as document text with a faint tint; an
        // outstanding one stays obviously unfinished.
        className={`mx-0.5 inline-flex items-baseline gap-1 rounded-[2px] px-1 py-[1px] font-medium transition-colors ${
          settled
            ? 'bg-[#eaf5ec] text-[#14532d] hover:bg-[#d8ebdd]'
            : 'border border-dashed border-[#d9a441] bg-[#fdf6e7] text-[#8a5a06] hover:bg-[#faedcf]'
        }`}
        style={{ fontFamily: 'inherit', fontSize: '0.95em' }}
      >
        {settled ? value : blank.label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <span
          role="dialog"
          className="absolute left-0 top-[calc(100%+4px)] z-20 block w-64 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg"
        >
          <span className="mb-1 block px-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
            {blank.label}
          </span>
          <span className="block max-h-44 overflow-auto">
            {blank.candidates.length > 0 ? (
              blank.candidates.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onChoose(c.value)}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] text-[var(--text)] hover:bg-[var(--accent)]"
                >
                  <span className="truncate">{c.label}</span>
                  <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{c.source}</span>
                </button>
              ))
            ) : (
              <span className="block px-2 py-1 text-[12px] text-[var(--text-muted)]">
                No saved options — type a value.
              </span>
            )}
          </span>
          <span className="mt-1.5 flex items-center gap-1 border-t border-[var(--border)] pt-1.5">
            <input
              type={blank.kind === 'date' ? 'text' : 'text'}
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && freeText.trim()) onChoose(freeText.trim())
              }}
              placeholder={blank.kind === 'date' ? 'e.g. 31 March 2026' : 'Type a value…'}
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
            />
            <button
              type="button"
              onClick={() => freeText.trim() && onChoose(freeText.trim())}
              className="rounded bg-[var(--accent)] px-2 py-1 text-[12px] font-medium text-[var(--text)] hover:opacity-90"
            >
              Set
            </button>
          </span>
        </span>
      )}
    </span>
  )
}
