'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

interface DocxViewerProps {
  url: string
  className?: string
}

export default function DocxViewer({ url, className = '' }: DocxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!url || !containerRef.current) return

    setLoading(true)
    setError(null)

    const render = async () => {
      try {
        const { renderAsync } = await import('docx-preview')

        const tok = typeof window !== 'undefined' ? (localStorage.getItem('ls_token') || '') : ''
        const res = await fetch(url, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {})
        if (!res.ok) throw new Error('Failed to fetch document')
        const blob = await res.blob()

        if (containerRef.current) {
          containerRef.current.innerHTML = ''
          await renderAsync(blob, containerRef.current, undefined, {
            className: 'docx-preview',
            inWrapper: true,
            ignoreWidth: true,
            ignoreHeight: true,
            ignoreFonts: false,
            breakPages: true,
            ignoreLastRenderedPageBreak: true,
            experimental: false,
            trimXmlDeclaration: true,
            useBase64URL: true,
          })
        }
      } catch (e: any) {
        setError(e.message || 'Failed to render document')
      } finally {
        setLoading(false)
      }
    }

    render()
  }, [url])

  return (
    <div className={`relative ${className}`}>
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-white z-10 gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-brand" />
          <p className="text-sm text-gray-500">Rendering document...</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-white z-10">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      )}
      <div
        ref={containerRef}
        className="w-full h-full overflow-auto bg-white"
        style={{ minHeight: '100%' }}
      />
      <style jsx global>{`
        .docx-preview {
          padding: 0 !important;
        }
        .docx-preview .docx-wrapper {
          background: #f5f5f5 !important;
          padding: 16px !important;
          display: flex;
          flex-direction: column;
          align-items: center;
          min-height: 100%;
          overflow-x: auto;
        }
        .docx-preview .docx-wrapper > section.docx {
          background: white !important;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12) !important;
          margin-bottom: 16px !important;
          min-height: auto !important;
          flex-shrink: 0;
        }
        .docx-preview .docx-wrapper > section.docx > * {
          overflow-wrap: break-word;
          word-wrap: break-word;
        }
        .docx-preview table {
          max-width: 100%;
          font-size: 0.9em;
          table-layout: fixed;
          word-break: break-word;
        }
        .docx-preview img {
          max-width: 100%;
          height: auto;
        }
      `}</style>
    </div>
  )
}
