'use client'

import { FC } from 'react'
import { Download, FileText, PanelRight } from 'lucide-react'
import { useStore } from '@/store'

interface DocumentCardProps {
  url: string
  fileName?: string
}

/**
 * The compact document card in the transcript.
 *
 * "View" sends the file to the right-hand panel rather than expanding a preview
 * inside the message. A document embedded in the chat pushes the conversation
 * off screen and gets re-rendered on every new message; the panel is a stable
 * place to read it, and it stays put while the conversation continues.
 *
 * rounded-[var(--radius-xl)] rather than rounded-xl: the radius comes from the
 * token layer so the card tracks the design tokens, not Tailwind's own scale.
 */
const DocumentCard: FC<DocumentCardProps> = ({ url, fileName }) => {
  const requestPreview = useStore((s) => s.requestPreview)
  const extractedFileName = fileName || url.split('/').pop() || 'document.docx'
  const extension = extractedFileName.split('.').pop()?.toUpperCase() || 'FILE'
  const isDocx = extension === 'DOCX' || extension === 'DOC'

  // The panel resolves its own preview URL from the file name, so the card only
  // has to say WHICH document it means.
  const docFileName = url.split('/').pop() || ''

  return (
    <div className="my-3 max-w-2xl">
      <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <div className="flex items-center gap-3 p-3.5">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-xl)] bg-[var(--accent)]"
            aria-hidden="true"
          >
            <FileText className="h-5 w-5 text-[var(--accent-fg)]" />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p
              className="truncate font-[family-name:var(--font-body)] text-[length:var(--text-sm)] font-medium text-[var(--text)]"
              title={extractedFileName}
            >
              {extractedFileName}
            </p>
            <p className="font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {extension} document
            </p>
          </div>

          {isDocx && docFileName && (
            <button
              type="button"
              onClick={() => requestPreview(docFileName)}
              title={`Open ${extractedFileName} in the document panel`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-xl)]
                         px-2.5 py-1.5 font-[family-name:var(--font-body)]
                         text-[length:var(--text-xs)] text-[var(--text-muted)]
                         transition-colors duration-150 motion-reduce:transition-none
                         hover:bg-[var(--accent)] hover:text-[var(--text)]
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            >
              <PanelRight className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">View</span>
            </button>
          )}

          <a
            href={url}
            download
            title={`Download ${extractedFileName}`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-xl)]
                       bg-[var(--brand)] px-3 py-1.5 font-[family-name:var(--font-body)]
                       text-[length:var(--text-xs)] font-medium text-[var(--brand-fg)]
                       transition-opacity duration-150 motion-reduce:transition-none
                       hover:opacity-90
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]
                       focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </a>
        </div>
      </div>
    </div>
  )
}

export default DocumentCard
