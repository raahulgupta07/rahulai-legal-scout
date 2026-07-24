'use client'

/**
 * The right rail: the document as it is being assembled.
 *
 * This panel is scanned, not read. State is encoded in form before it is
 * encoded in words — a left stripe per row, a segmented completion meter, a
 * status chip — so a glance answers "what's still missing" without parsing
 * sentences.
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

  if (!artifact) {
    return <EmptyState working={isStreaming} />
  }

  const status = STATUS[artifact.status]
  const pending = artifact.fields.filter((f) => f.state !== 'filled')

  return (
    <section
      aria-label="Document artifact"
      className="flex h-full min-h-0 flex-col border-l border-[var(--border)] bg-[var(--bg-secondary)]"
    >
      {/* ── identity ─────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 pb-4 pt-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[11px] font-medium uppercase tracking-[var(--tracking-wide)] text-[var(--text-muted)]">
            Document
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${status.className}`}
          >
            {status.live && isStreaming && (
              <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
            )}
            {status.label}
          </span>
        </div>

        <h2 className="break-words text-[15px] font-semibold leading-tight text-[var(--text)]">
          {artifact.title}
        </h2>

        {(artifact.templateName || artifact.companyName) && (
          <p className="mt-1 truncate text-[12px] text-[var(--text-muted)]">
            {[artifact.templateName, artifact.companyName]
              .filter(Boolean)
              .join('  ·  ')}
          </p>
        )}

        <Meter fields={artifact.fields} filled={artifact.filled} total={artifact.total} />
      </header>

      {/* ── tabs ─────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Document view"
        className="flex shrink-0 gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-3"
      >
        <TabButton active={tab === 'fields'} onClick={() => setTab('fields')}>
          Fields
          <span className="ml-1.5 font-[family-name:var(--font-mono)] tabular-nums opacity-60">
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

      {/* ── body ─────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'fields' ? (
          <FieldList fields={artifact.fields} message={artifact.message} />
        ) : previewUrl ? (
          <div className="h-full">
            <DocViewer url={previewUrl} forceFormat="pdf" className="h-full" />
          </div>
        ) : null}
      </div>

      {/* ── actions ──────────────────────────────────────────── */}
      <footer className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3">
        {artifact.downloadUrl ? (
          <div className="flex items-center gap-2">
            <a
              href={absoluteUrl(artifact.downloadUrl)}
              download={artifact.fileName ?? undefined}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--brand)] px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[#1D4ED8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
            >
              <Download className="h-4 w-4" aria-hidden />
              Download .docx
            </a>
            <button
              type="button"
              onClick={() => setPreviewNonce((n) => n + 1)}
              title="Re-render preview"
              aria-label="Re-render preview"
              className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            >
              <RotateCw className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--border-strong)]"
              aria-hidden
            />
            {pending.length
              ? `${pending.length} field${pending.length === 1 ? '' : 's'} to resolve before download`
              : 'Awaiting generation'}
          </p>
        )}
      </footer>
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
    <div className="mt-3.5">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[var(--tracking-wide)] text-[var(--text-muted)]">
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
      <p className="px-5 py-6 text-[13px] text-[var(--text-muted)]">
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
      <h3 className="flex items-baseline justify-between border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[var(--tracking-wide)] text-[var(--text-secondary)]">
        {title}
        <span className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-muted)]">
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
      className={`-mb-px border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'border-[var(--brand)] text-[var(--text)]'
          : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
      }`}
    >
      {children}
    </button>
  )
}

/* ── empty state ────────────────────────────────────────────── */

function EmptyState({ working }: { working: boolean }) {
  return (
    <section
      aria-label="Document artifact"
      className="flex h-full min-h-0 flex-col border-l border-[var(--border)] bg-[var(--bg-secondary)]"
    >
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-4">
        <span className="text-[11px] font-medium uppercase tracking-[var(--tracking-wide)] text-[var(--text-muted)]">
          Document
        </span>
        <h2 className="mt-1 text-[15px] font-semibold leading-tight text-[var(--text)]">
          Nothing in progress
        </h2>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-6 px-6">
        {/* A ghost of the thing that will appear here — same row rhythm and
            stripe as a real field list, drawn as an outline. */}
        <div
          aria-hidden
          className="w-full max-w-[300px] rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] p-3"
        >
          {[68, 44, 82, 56].map((w, i) => (
            <div key={i} className="mb-2.5 flex items-center gap-2.5 last:mb-0">
              <span className="h-4 w-[3px] shrink-0 rounded-[1px] bg-[var(--border-strong)]" />
              <span className="h-2 w-16 shrink-0 rounded-full bg-[var(--border-strong)] opacity-60" />
              <span
                className="h-2 rounded-full bg-[var(--border-strong)] opacity-30"
                style={{ width: `${w}px` }}
              />
            </div>
          ))}
        </div>

        <div className="max-w-[340px]">
          <p className="text-[15px] font-semibold text-[var(--text)]">
            {working ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Working
              </span>
            ) : (
              'Ask for a document'
            )}
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
            {working
              ? 'The panel fills in as soon as the agent opens a template.'
              : 'Name a template and a company — “AGM minutes for City Holdings”. Fields, completion and the download land here as the agent resolves them.'}
          </p>
        </div>

        <p className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          Myanmar corporate law templates
        </p>
      </div>
    </section>
  )
}
