'use client'

/**
 * The right rail: the document as it is being assembled — an Insights
 * "artifact frame". A hairline rounded card floats on the pane; its toolbar
 * carries the title and the actions, its body carries the fields or the
 * preview. The panel is scanned, not read: a completion meter and a status
 * chip answer "what's still missing" at a glance.
 */

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Download, FileText, Loader2, RotateCw } from 'lucide-react'
import { useStore } from '@/store'
import type { Artifact, ArtifactField, ArtifactStatus } from './useArtifact'

const DocViewer = dynamic(() => import('@/components/ui/DocViewer'), {
  ssr: false
})

const API_BASE = process.env.NEXT_PUBLIC_API_URL || ''

type Tab = 'fields' | 'preview'

/** Status pill colouring — a green-family tint scale, warn/danger for the
 *  exceptions. All alpha comes from color-mix so it tracks the theme. */
const STATUS: Record<
  ArtifactStatus,
  { label: string; className: string; live?: boolean }
> = {
  preparing: {
    label: 'Assembling',
    className:
      'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]',
    live: true
  },
  'awaiting-input': {
    label: 'Needs input',
    className:
      'border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_12%,transparent)] text-[var(--warn)]'
  },
  ready: {
    label: 'Ready',
    className:
      'border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] text-[var(--ok-strong)]'
  },
  generated: {
    label: 'Generated',
    className: 'border-transparent bg-[var(--ok)] text-white'
  },
  error: {
    label: 'Blocked',
    className:
      'border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger-strong)]'
  }
}

const STRIPE: Record<ArtifactField['state'], string> = {
  filled: 'bg-[var(--ok)]',
  tbd: 'bg-[var(--warn)]',
  pending: 'bg-[var(--border-strong)]'
}

/** The hairline card that frames every pane state. */
const CARD_FRAME =
  'h-full w-full overflow-hidden rounded-xl border border-black/[0.08] bg-[#f8f8f7] dark:border-white/[0.07] dark:bg-gray-900'

/**
 * generate_document returns a root-relative path. That resolves correctly only
 * when the API and the frontend share an origin (true in the packaged
 * container, false in dev against a remote API).
 */
function absoluteUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`
}

function authToken() {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem('ls_token') || ''
  } catch {
    return ''
  }
}

export default function ArtifactPanel({
  artifact
}: {
  artifact: Artifact | null
}) {
  const isStreaming = useStore((s) => s.isStreaming)
  const [tab, setTab] = useState<Tab>('fields')
  const [previewNonce, setPreviewNonce] = useState(0)

  const fileName = artifact?.fileName ?? null

  // A freshly generated file deserves the preview, not the field list the
  // user has already watched fill in.
  useEffect(() => {
    if (fileName) setTab('preview')
  }, [fileName])

  const previewUrl = useMemo(() => {
    if (!fileName) return null
    const tok = authToken()
    return `${API_BASE}/api/documents/preview-pdf/${encodeURIComponent(
      fileName
    )}?token=${encodeURIComponent(tok)}&v=${previewNonce}`
  }, [fileName, previewNonce])

  // ── empty / working ──────────────────────────────────────────
  if (!artifact) {
    return (
      <section
        aria-label="Document artifact"
        className="flex h-full min-h-0 flex-col bg-[var(--surface)]"
      >
        <div className="min-h-0 flex-1 p-2 pt-1.5">
          <div className={`relative ${CARD_FRAME}`}>
            <StateMessage working={isStreaming} />
          </div>
        </div>
      </section>
    )
  }

  const status = STATUS[artifact.status]
  const meta = [artifact.templateName, artifact.companyName].filter(Boolean).join('  ·  ')

  return (
    <section
      aria-label="Document artifact"
      className="flex h-full min-h-0 flex-col bg-[var(--surface)]"
    >
      {/* ── pane header: tabs + status ───────────────────────── */}
      <div className="flex items-center justify-between px-3 pt-1.5">
        <div role="tablist" aria-label="Document view" className="flex items-center gap-1">
          <TabButton active={tab === 'fields'} onClick={() => setTab('fields')}>
            Fields
            <span className="text-[10px] tabular-nums text-[var(--text-muted)]">
              {artifact.fields.length}
            </span>
          </TabButton>
          <TabButton
            active={tab === 'preview'}
            onClick={() => setTab('preview')}
            disabled={!previewUrl}
          >
            Preview
          </TabButton>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${status.className}`}
        >
          {status.live && isStreaming && (
            <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          )}
          {status.label}
        </span>
      </div>

      {/* ── framed card ──────────────────────────────────────── */}
      <div className="min-h-0 flex-1 p-2 pt-1.5">
        <div className={CARD_FRAME}>
          <div className="flex h-full min-h-0 flex-col bg-[var(--surface)]">
            {/* toolbar: title + actions, over a faint cyan wash */}
            <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-gradient-to-b from-cyan-50/50 to-white px-4 py-2 dark:from-cyan-900/10 dark:to-gray-900">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  title={artifact.title}
                  className="truncate text-[13px] font-medium text-[var(--text-secondary)]"
                >
                  {artifact.title}
                </span>
                {meta && (
                  <span className="truncate text-[11px] text-[var(--faint,#9CA3AF)]">
                    {meta}
                  </span>
                )}
              </div>

              {artifact.downloadUrl && (
                <div className="flex flex-shrink-0 items-center gap-1">
                  <a
                    href={absoluteUrl(artifact.downloadUrl)}
                    download={artifact.fileName ?? undefined}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-blue-600 transition-colors hover:bg-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] dark:text-blue-400"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden />
                    Download
                  </a>
                  <button
                    type="button"
                    onClick={() => setPreviewNonce((n) => n + 1)}
                    title="Re-render preview"
                    aria-label="Re-render preview"
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                  >
                    <RotateCw className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              )}
            </div>

            {/* body: fields (meter + list) or preview */}
            {tab === 'fields' ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex-shrink-0 border-b border-[var(--border)] px-4 py-3">
                  <Meter
                    fields={artifact.fields}
                    filled={artifact.filled}
                    total={artifact.total}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <FieldList fields={artifact.fields} message={artifact.message} />
                </div>
              </div>
            ) : previewUrl ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <DocViewer url={previewUrl} forceFormat="pdf" className="h-full" />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ── completion meter ───────────────────────────────────────── */

function Meter({
  fields,
  filled,
  total
}: {
  fields: ArtifactField[]
  filled: number
  total: number
}) {
  // One cell per field reads as a checklist at a glance, but past ~40 fields
  // the cells become noise — fall back to a plain proportional bar.
  const segmented = fields.length > 0 && fields.length <= 40
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          Fields resolved
        </span>
        <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] font-semibold tabular-nums text-[var(--text)]">
          {filled}
          <span className="text-[var(--text-muted)]">/{total}</span>
        </span>
      </div>

      {segmented ? (
        <div
          className="flex gap-[2px] rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-[2px]"
          role="img"
          aria-label={`${filled} of ${total} fields resolved`}
        >
          {fields.map((f) => (
            <i
              key={f.key}
              title={`${f.label}: ${f.state}`}
              className={`h-2.5 flex-1 rounded-[1px] ${STRIPE[f.state]}`}
            />
          ))}
        </div>
      ) : (
        <div
          className="h-2.5 overflow-hidden rounded-full bg-[var(--accent)]"
          role="img"
          aria-label={`${pct}% of fields resolved`}
        >
          <div className="h-full rounded-full bg-[var(--ok)]" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

/* ── field list ─────────────────────────────────────────────── */

function FieldList({
  fields,
  message
}: {
  fields: ArtifactField[]
  message: string | null
}) {
  const pending = fields.filter((f) => f.state !== 'filled')
  const filled = fields.filter((f) => f.state === 'filled')

  if (!fields.length) {
    return (
      <p className="px-4 py-6 text-sm text-[var(--faint,#9CA3AF)]">
        No fields discovered yet. They appear as the agent reads the template.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {message && (
        <p className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {message}
        </p>
      )}

      {pending.length > 0 && (
        <FieldGroup title="Outstanding" count={pending.length} fields={pending} />
      )}
      {filled.length > 0 && (
        <FieldGroup title="Resolved" count={filled.length} fields={filled} />
      )}
    </div>
  )
}

function FieldGroup({
  title,
  count,
  fields
}: {
  title: string
  count: number
  fields: ArtifactField[]
}) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)]">
      <h3 className="flex items-baseline justify-between border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)]">
        {title}
        <span className="font-[family-name:var(--font-mono)] text-xs tabular-nums text-[var(--text-muted)]">
          {count}
        </span>
      </h3>
      <ul>
        {fields.map((f) => (
          <FieldRow key={f.key} field={f} />
        ))}
      </ul>
    </div>
  )
}

function FieldRow({ field }: { field: ArtifactField }) {
  return (
    <li className="relative flex items-start gap-3 border-b border-[var(--border)] py-2.5 pl-5 pr-4 last:border-b-0">
      <span
        className={`absolute left-0 top-0 h-full w-[3px] ${STRIPE[field.state]}`}
        aria-hidden
      />
      <span className="w-[42%] shrink-0 break-words font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] uppercase leading-relaxed tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
        {field.label}
      </span>
      <span
        className={`min-w-0 flex-1 break-words text-[13px] leading-relaxed ${
          field.state === 'filled'
            ? 'text-[var(--text)]'
            : field.state === 'tbd'
              ? 'font-medium text-[var(--warn)]'
              : 'text-[var(--text-muted)]'
        }`}
      >
        {field.state === 'pending' ? (
          <span className="font-[family-name:var(--font-mono)] uppercase tracking-[var(--tracking-tag)]">
            Pending
          </span>
        ) : (
          (field.value ?? '—')
        )}
      </span>
    </li>
  )
}

/* ── chrome ─────────────────────────────────────────────────── */

function TabButton({
  active,
  disabled,
  onClick,
  children
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-[var(--accent)] text-[var(--text)]'
          : 'text-[var(--faint,#9CA3AF)] hover:text-[var(--text-muted)]'
      }`}
    >
      {children}
    </button>
  )
}

/* ── empty / working message ────────────────────────────────── */

function StateMessage({ working }: { working: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6">
      <div className="flex flex-col items-center text-center">
        {working ? (
          <Loader2 className="mb-2 h-6 w-6 animate-spin text-[var(--faint,#9CA3AF)]" aria-hidden />
        ) : (
          <FileText className="mb-2 h-6 w-6 text-[var(--faint,#9CA3AF)]" aria-hidden />
        )}
        <p className="text-sm text-[var(--faint,#9CA3AF)]">
          {working ? 'Working…' : 'No document yet'}
        </p>
        {!working && (
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Ask for a document — fields, completion and the download land here.
          </p>
        )}
      </div>
    </div>
  )
}
