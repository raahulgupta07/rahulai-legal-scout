'use client'

import { FC, useState } from 'react'
import { Download, FileText, Eye, X, Loader2 } from 'lucide-react'
import DocViewer from '@/components/ui/DocViewer'

interface DocumentCardProps {
  url: string
  fileName?: string
}

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
      {/* Card */}
      <div className="inline-flex w-full items-center gap-3 border-[2px] border-[#383832] bg-[#feffd6] p-4 stamp-shadow">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center bg-[#383832]">
          <FileText className="h-6 w-6 text-white" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-sm font-semibold text-primary" title={extractedFileName}>
            {extractedFileName}
          </p>
          <p className="text-xs text-muted">{extension} Document</p>
        </div>
        {isDocx && (
          <button
            onClick={handlePreview}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-all ${
              showPreview ? 'bg-gray-200 text-gray-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700'
            }`}
            title={showPreview ? 'Hide preview' : 'Preview document'}
          >
            {showPreview ? <X className="h-4 w-4" /> : <Eye className="h-5 w-5" />}
          </button>
        )}
        <a href={url} download
          className="flex h-10 w-10 shrink-0 items-center justify-center bg-[#007518] text-white hover:bg-[#005c13] transition-all ink-border stamp-press"
          title="Download document">
          <Download className="h-5 w-5" />
        </a>
      </div>

      {/* PDF Preview */}
      {showPreview && isDocx && (
        <div className="mt-2 rounded-xl border border-gray-300 overflow-hidden bg-white shadow-sm">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-brand" />
              <span className="text-xs font-semibold text-gray-700">Document Preview</span>
              {pdfLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted" />}
            </div>
            <button onClick={() => setShowPreview(false)} className="p-1 hover:bg-gray-200 rounded text-gray-500 hover:text-gray-700">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <DocViewer url={pdfPreviewUrl} forceFormat="pdf" className="w-full" />
        </div>
      )}
    </div>
  )
}

export default DocumentCard
