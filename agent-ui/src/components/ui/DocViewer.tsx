'use client'

import dynamic from 'next/dynamic'

const PdfViewer = dynamic(() => import('./PdfViewer'), { ssr: false })
const DocxViewer = dynamic(() => import('./DocxViewer'), { ssr: false })

interface DocViewerProps {
  url: string
  className?: string
  forceFormat?: 'pdf' | 'docx'
}

export default function DocViewer({ url, className = '', forceFormat }: DocViewerProps) {
  if (!url) return null
  if (forceFormat === 'pdf') return <PdfViewer url={url} className={className} />
  if (forceFormat === 'docx') return <DocxViewer url={url} className={className} />
  const lower = url.toLowerCase()
  // Server-converted preview endpoint always returns PDF regardless of source extension
  if (lower.includes('/preview-pdf/')) return <PdfViewer url={url} className={className} />
  const path = lower.split('?')[0]
  if (path.endsWith('.pdf')) return <PdfViewer url={url} className={className} />
  if (path.endsWith('.docx') || path.endsWith('.doc'))
    return <DocxViewer url={url} className={className} />
  return (
    <div className={`flex items-center justify-center bg-white ${className}`}>
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm underline">
        Open file
      </a>
    </div>
  )
}
