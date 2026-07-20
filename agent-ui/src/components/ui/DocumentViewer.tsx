"use client"

import { useState } from "react"
import { X, FileText, Download, Eye, ExternalLink } from "lucide-react"
import DocViewer from "./DocViewer"

interface DocumentCardProps {
  fileName: string
  downloadUrl: string
  previewUrl?: string
  onPreview?: () => void
}

export function DocumentCard({
  fileName,
  downloadUrl,
  previewUrl,
}: DocumentCardProps) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)

  const handlePreview = () => {
    if (previewUrl) {
      setIsPreviewOpen(true)
    }
  }

  return (
    <>
      <div className="flex items-center gap-3 p-3 bg-[color-mix(in_srgb,var(--text-muted)_50%,transparent)] rounded-none border">
        <div className="flex-shrink-0">
          <FileText className="w-8 h-8 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{fileName}</p>
          <p className="text-xs text-muted-foreground">Legal Document</p>
        </div>
        <div className="flex gap-2">
          {previewUrl && (
            <button
              onClick={handlePreview}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-none hover:bg-[color-mix(in_srgb,var(--text)_90%,transparent)] transition-colors"
            >
              <Eye className="w-3.5 h-3.4" />
              Preview
            </button>
          )}
          <a
            href={downloadUrl}
            download
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-input bg-background rounded-none hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </a>
        </div>
      </div>

      {isPreviewOpen && previewUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-5xl h-[85vh] bg-background rounded-none shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b bg-[color-mix(in_srgb,var(--text-muted)_30%,transparent)]">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-primary" />
                <span className="font-medium truncate max-w-md">{fileName}</span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={downloadUrl}
                  download
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-input bg-background rounded-none hover:bg-accent transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </a>
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-input bg-background rounded-none hover:bg-accent transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open
                </a>
                <button
                  onClick={() => setIsPreviewOpen(false)}
                  className="p-1.5 rounded-none hover:bg-accent transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <DocViewer url={previewUrl || downloadUrl} className="w-full h-full" />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

interface DocumentCardsProps {
  documents: Array<{
    fileName: string
    downloadUrl: string
    previewUrl?: string
  }>
}

export function DocumentCards({ documents }: DocumentCardsProps) {
  if (!documents || documents.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {documents.map((doc, index) => (
        <DocumentCard
          key={index}
          fileName={doc.fileName}
          downloadUrl={doc.downloadUrl}
          previewUrl={doc.previewUrl}
        />
      ))}
    </div>
  )
}
