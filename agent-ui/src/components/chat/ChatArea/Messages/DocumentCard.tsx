'use client'

import { FC, useState } from 'react'
import { Download, FileText, Eye, EyeOff, X, Loader2 } from 'lucide-react'
import DocViewer from '@/components/ui/DocViewer'

interface DocumentCardProps {
  url: string
  fileName?: string
}

/*
  rounded-[var(--radius-xl)] rather than rounded-xl: the radius comes from the
  --radius-xl token so the card tracks the token layer rather than Tailwind's
  own rounding scale.
*/
const DocumentCard: FC<DocumentCardProps> = ({ url, fileName }) => {
  const [showPreview, setShowPreview] = useState(true)
  const [pdfLoading, setPdfLoading] = useState(false)
  const extractedFileName = fileName || url.split('/').pop() || 'document.docx'
  const extension = extractedFileName.split('.').pop()?.toUpperCase() || 'FILE'
  const isDocx = extension === 'DOCX' || extension === 'DOC'

  // Extract just the filename from the full URL and build the PDF preview URL
  const docFileName = url.split('/').pop() || ''
  const apiBase = process.env.NEXT_PUBLIC_API_URL || ''
  const tok = typeof window !== 'undefined' ? (localStorage.getItem('ls_token') || '') : ''
  const pdfPreviewUrl = `${apiBase}/api/documents/preview-pdf/${encodeURIComponent(docFileName)}?token=${tok}`

  const handlePreview = () => {
    if (!showPreview) {
      setPdfLoading(true)
    }
    setShowPreview(!showPreview)
  }

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

          {isDocx && (
            <button
              type="button"
              onClick={handlePreview}
              aria-expanded={showPreview}
              title={showPreview ? 'Hide preview' : 'Preview document'}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-xl)]
                         px-2.5 py-1.5 font-[family-name:var(--font-body)]
                         text-[length:var(--text-xs)] text-[var(--text-muted)]
                         transition-colors duration-150 motion-reduce:transition-none
                         hover:bg-[var(--accent)] hover:text-[var(--text)]
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            >
              {showPreview ? (
                <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">{showPreview ? 'Hide' : 'Preview'}</span>
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

        {showPreview && isDocx && (
          <div className="border-t border-[var(--border)]">
            <div className="flex items-center justify-between px-3.5 py-2">
              <div className="flex items-center gap-2">
                <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                  Preview
                </span>
                {pdfLoading && (
                  <Loader2
                    className="h-3 w-3 animate-spin text-[var(--text-muted)] motion-reduce:animate-none"
                    aria-label="Loading preview"
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowPreview(false)}
                aria-label="Close preview"
                className="rounded-[var(--radius-xl)] p-1 text-[var(--text-muted)]
                           transition-colors duration-150 motion-reduce:transition-none
                           hover:bg-[var(--accent)] hover:text-[var(--text)]
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div className="overflow-hidden rounded-b-[var(--radius-xl)] bg-[var(--surface-raised)]">
              <DocViewer url={pdfPreviewUrl} forceFormat="pdf" className="w-full" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default DocumentCard
