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

const STATUS: Record<
  ArtifactStatus,
  { label: string; className: string; live?: boolean }
> = {
  preparing: {
    label: 'Assembling',
    className: 'border-ink bg-background text-ink',
    live: true
  },
  'awaiting-input': {
    label: 'Needs input',
    className: 'border-warn bg-warn text-[var(--ink)]'
  },
  ready: {
    label: 'Ready',
    className: 'border-ok bg-background text-ok'
  },
  generated: {
    label: 'Generated',
    className: 'border-ok bg-ok text-[var(--bg)]'
  },
  error: {
    label: 'Blocked',
    className: 'border-danger bg-danger text-[var(--bg)]'
  }
}

const STRIPE: Record<ArtifactField['state'], string> = {
  filled: 'bg-ok',
  tbd: 'bg-warn',
  pending: 'bg-[var(--border)]'
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
      className="flex h-full min-h-0 flex-col border-l-[3px] border-ink bg-[var(--bg-secondary)]"
    >
      {/* ── identity ─────────────────────────────────────────── */}
      <header className="shrink-0 border-b-[3px] border-ink bg-background px-5 pb-4 pt-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="font-display text-2xs font-black uppercase tracking-brutal text-muted">
            Document
          </span>
          <span
            className={`inline-flex items-center gap-1.5 border-[2px] px-2 py-0.5 font-display text-2xs font-black uppercase tracking-tag ${status.className}`}
          >
            {status.live && isStreaming && (
              <i className="h-1.5 w-1.5 animate-pulse bg-current" aria-hidden />
            )}
            {status.label}
          </span>
        </div>

        <h2 className="break-words font-display text-lg font-black leading-tight text-ink">
          {artifact.title}
        </h2>

        {(artifact.templateName || artifact.companyName) && (
          <p className="mt-1.5 truncate font-mono text-2xs uppercase tracking-tag text-muted">
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
        className="flex shrink-0 gap-0 border-b-[3px] border-ink bg-background"
      >
        <TabButton active={tab === 'fields'} onClick={() => setTab('fields')}>
          Fields
          <span className="ml-1.5 font-mono tabular-nums opacity-60">
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
      <footer className="shrink-0 border-t-[3px] border-ink bg-background px-5 py-3">
        {artifact.downloadUrl ? (
          <div className="flex items-center gap-2">
            <a
              href={absoluteUrl(artifact.downloadUrl)}
              download={artifact.fileName ?? undefined}
              className="inline-flex flex-1 items-center justify-center gap-2 border-[3px] border-ink bg-ink px-4 py-2.5 font-display text-xs font-black uppercase tracking-brutal text-[var(--text-inverse)] shadow-[4px_4px_0_var(--ink)] transition-transform hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_var(--ink)] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none"
            >
              <Download className="h-4 w-4" aria-hidden />
              Download .docx
            </a>
            <button
              type="button"
              onClick={() => setPreviewNonce((n) => n + 1)}
              title="Re-render preview"
              aria-label="Re-render preview"
              className="inline-flex h-[46px] w-[46px] items-center justify-center border-[3px] border-ink bg-background text-ink transition-colors hover:bg-[var(--bg-secondary)]"
            >
              <RotateCw className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : (
          <p className="flex items-center gap-2 font-mono text-2xs uppercase tracking-tag text-muted">
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 bg-[var(--border)]"
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
        <span className="font-display text-2xs font-black uppercase tracking-brutal text-muted">
          Fields resolved
        </span>
        <span className="font-mono text-xs font-bold tabular-nums text-ink">
          {filled}
          <span className="text-muted">/{total}</span>
        </span>
      </div>

      {segmented ? (
        <div
          className="flex gap-[2px] border-[2px] border-ink bg-background p-[2px]"
          role="img"
          aria-label={`${filled} of ${total} fields resolved`}
        >
          {fields.map((f) => (
            <i
              key={f.key}
              title={`${f.label}: ${f.state}`}
              className={`h-2.5 flex-1 ${STRIPE[f.state]}`}
            />
          ))}
        </div>
      ) : (
        <div
          className="h-3 border-[2px] border-ink bg-background p-[1px]"
          role="img"
          aria-label={`${pct}% of fields resolved`}
        >
          <div className="h-full bg-ok" style={{ width: `${pct}%` }} />
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
      <p className="px-5 py-6 font-mono text-xs text-muted">
        No fields discovered yet. They appear as the agent reads the template.
      </p>
    )
  }

  return (
    <div className="pb-4">
      {message && (
        <p className="border-b-[2px] border-[var(--border)] bg-background px-5 py-3 font-body text-xs leading-relaxed text-[var(--text-secondary)]">
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
    <div>
      <h3 className="sticky top-0 z-10 flex items-baseline justify-between border-b-[2px] border-ink bg-[var(--bg-secondary)] px-5 py-2 font-display text-2xs font-black uppercase tracking-brutal text-ink">
        {title}
        <span className="font-mono tabular-nums text-muted">{count}</span>
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
    <li className="relative flex items-start gap-3 border-b-[1px] border-[var(--border)] bg-background py-2.5 pl-5 pr-5">
      <span
        className={`absolute left-0 top-0 h-full w-[3px] ${STRIPE[field.state]}`}
        aria-hidden
      />
      <span className="w-[42%] shrink-0 break-words font-mono text-2xs uppercase leading-relaxed tracking-tag text-muted">
        {field.label}
      </span>
      <span
        className={`min-w-0 flex-1 break-words font-body text-xs leading-relaxed ${
          field.state === 'filled'
            ? 'text-ink'
            : field.state === 'tbd'
              ? 'font-bold text-warn'
              : 'text-muted'
        }`}
      >
        {field.state === 'pending' ? (
          <span className="font-mono uppercase tracking-tag">Pending</span>
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
      className={`border-r-[3px] border-ink px-5 py-2.5 font-display text-2xs font-black uppercase tracking-brutal transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? 'bg-ink text-[var(--text-inverse)]'
          : 'bg-background text-ink hover:bg-[var(--bg-secondary)]'
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
      className="flex h-full min-h-0 flex-col border-l-[3px] border-ink bg-[var(--bg-secondary)]"
    >
      <header className="shrink-0 border-b-[3px] border-ink bg-background px-5 py-4">
        <span className="font-display text-2xs font-black uppercase tracking-brutal text-muted">
          Document
        </span>
        <h2 className="mt-1 font-display text-lg font-black leading-tight text-ink">
          Nothing in progress
        </h2>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-6 px-6">
        {/* A ghost of the thing that will appear here — same row rhythm and
            stripe as a real field list, drawn as an outline. */}
        <div
          aria-hidden
          className="w-full max-w-[300px] border-[3px] border-dashed border-[var(--border)] p-3"
        >
          {[68, 44, 82, 56].map((w, i) => (
            <div key={i} className="mb-2.5 flex items-center gap-2.5 last:mb-0">
              <span className="h-4 w-[3px] shrink-0 bg-[var(--border)]" />
              <span className="h-2 w-16 shrink-0 bg-[var(--border)] opacity-60" />
              <span
                className="h-2 bg-[var(--border)] opacity-30"
                style={{ width: `${w}px` }}
              />
            </div>
          ))}
        </div>

        <div className="max-w-[340px]">
          <p className="font-display text-sm font-black uppercase tracking-tag text-ink">
            {working ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Working
              </span>
            ) : (
              'Ask for a document'
            )}
          </p>
          <p className="mt-2 font-body text-xs leading-relaxed text-muted">
            {working
              ? 'The panel fills in as soon as the agent opens a template.'
              : 'Name a template and a company — “AGM minutes for City Holdings”. Fields, completion and the download land here as the agent resolves them.'}
          </p>
        </div>

        <p className="flex items-center gap-2 font-mono text-2xs uppercase tracking-tag text-muted">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          Myanmar corporate law templates
        </p>
      </div>
    </section>
  )
}
