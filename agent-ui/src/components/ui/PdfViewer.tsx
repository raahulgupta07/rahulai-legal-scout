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
        // The server returns JSON (not a PDF) on error. Read its message so the
        // user sees the real reason ("Source document file not found") rather
        // than pdf.js's cryptic "Invalid PDF structure" from parsing JSON bytes.
        const ctype = res.headers.get('content-type') || ''
        if (!res.ok || !ctype.includes('application/pdf')) {
          let reason = `Preview unavailable (${res.status})`
          try {
            const j = await res.clone().json()
            if (j?.error) reason = j.error
          } catch {
            /* not JSON — keep the status-based reason */
          }
          throw new Error(reason)
        }
        const buf = await res.arrayBuffer()

        const pdf = await pdfjsLib.getDocument({ data: buf }).promise
        if (cancelled || !containerRef.current) return
        containerRef.current.innerHTML = ''

        const total = pdf.numPages
        for (let n = 1; n <= total; n++) {
          const page = await pdf.getPage(n)
          const viewport = page.getViewport({ scale: 1.5 })
          // Each page = canvas + a "Page N / total" label, wrapped together.
          const wrap = document.createElement('div')
          wrap.style.cssText = 'margin:0 auto 20px;max-width:100%;width:fit-content;'
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.cssText =
            'display:block;box-shadow:0 2px 8px rgba(0,0,0,.12);max-width:100%;height:auto;background:white;'
          const label = document.createElement('div')
          label.textContent = `Page ${n} / ${total}`
          label.style.cssText =
            'margin-top:6px;text-align:center;font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums;'
          wrap.appendChild(canvas)
          wrap.appendChild(label)
          containerRef.current.appendChild(wrap)
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
    <div className={`relative min-h-[240px] ${className}`}>
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
      {/* Natural content height — the parent detail area owns the single scroll,
          so the PDF no longer traps the wheel in its own overflow region. */}
      <div
        ref={containerRef}
        className="w-full"
        style={{ background: '#f5f5f5', padding: '16px' }}
      />
    </div>
  )
}
