'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

interface PdfViewerProps {
  url: string
  className?: string
}

export default function PdfViewer({ url, className = '' }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!url || !containerRef.current) return
    let cancelled = false
    setLoading(true)
    setError(null)

    const render = async () => {
      try {
        const pdfjsLib: any = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

        const tok = typeof window !== 'undefined' ? (localStorage.getItem('ls_token') || '') : ''
        const res = await fetch(url, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {})
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
        const buf = await res.arrayBuffer()

        const pdf = await pdfjsLib.getDocument({ data: buf }).promise
        if (cancelled || !containerRef.current) return
        containerRef.current.innerHTML = ''

        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n)
          const viewport = page.getViewport({ scale: 1.5 })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.cssText =
            'display:block;margin:0 auto 12px;box-shadow:0 2px 8px rgba(0,0,0,.12);max-width:100%;height:auto;background:white;'
          containerRef.current.appendChild(canvas)
          const ctx = canvas.getContext('2d')!
          await page.render({ canvasContext: ctx, viewport }).promise
          if (cancelled) return
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to render PDF')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    render()
    return () => {
      cancelled = true
    }
  }, [url])

  return (
    <div className={`relative ${className}`}>
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-white z-10 gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-brand" />
          <p className="text-sm text-gray-500">Rendering PDF…</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-white z-10 p-4">
          <p className="text-sm text-red-500">{error}</p>
        </div>
      )}
      <div
        ref={containerRef}
        className="w-full h-full overflow-auto"
        style={{ background: '#f5f5f5', padding: '16px' }}
      />
    </div>
  )
}
