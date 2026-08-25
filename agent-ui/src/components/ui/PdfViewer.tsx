'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

interface PdfViewerProps {
  url: string
  className?: string
}

export default function PdfViewer({ url, className = '' }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // The worker we construct ourselves, so it can be terminated on unmount —
  // a module Worker is a real thread and leaks if nobody stops it.
  const workerRef = useRef<Worker | null>(null)
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
        // ★★★Own the worker explicitly — do NOT let pdf.js pick a global.
        //
        // MEASURED IN THE BROWSER, not inferred: this page carries
        // `globalThis.pdfjsLib` at version 5.2.133 and a matching
        // `globalThis.pdfjsWorker`, injected by a BROWSER EXTENSION. There are
        // no foreign <script> tags — it is injected into the page context. When
        // pdf.js sets up its worker it reuses an existing
        // `globalThis.pdfjsWorker.WorkerMessageHandler` if one is there, so our
        // bundled 4.0.379 API was talking to the extension's 5.2.133 worker:
        //   The API version "4.0.379" does not match the Worker version "5.2.133"
        // Nothing server-side could fix that, and no amount of cache-clearing
        // would either — the earlier cache theory was wrong.
        //
        // Constructing the Worker ourselves and handing it over as `workerPort`
        // bypasses the global lookup entirely, so whatever an extension puts on
        // the page is irrelevant.
        let ownWorker: Worker | null = null
        try {
          ownWorker = new Worker(
            `/pdf.worker.min.mjs?v=${pdfjsLib.version}`,
            { type: 'module' }
          )
          pdfjsLib.GlobalWorkerOptions.workerPort = ownWorker
          workerRef.current = ownWorker
        } catch {
          /* No module-worker support — fall through to workerSrc below. */
        }

        // ★ The worker URL carries the library's OWN version.
        //
        // It used to be the bare '/pdf.worker.min.mjs'. That path never changes,
        // the server sent no Cache-Control, and localhost:8080 hosts a different
        // app on this machine every few weeks — so a browser could hand pdf.js a
        // worker cached from something else entirely and fail with
        //   The API version "4.0.379" does not match the Worker version "5.2.133"
        // while the server was serving 4.0.379 the whole time. Keying the URL to
        // pdfjsLib.version means a mismatched cache entry cannot be reused,
        // because the bundle only ever requests the version it was built with.
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          `/pdf.worker.min.mjs?v=${pdfjsLib.version}`

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

        // ★ Self-heal a poisoned worker cache.
        //
        // Keying the URL to the version stops a stale entry being MATCHED, but
        // it cannot help a browser that already holds one for the path an older
        // bundle asked for. If pdf.js still reports a version mismatch, refetch
        // the worker with cache:'reload' — which bypasses the HTTP cache and
        // revalidates against the server — and hand pdf.js a blob URL, which
        // has no cache entry by construction. Retried exactly once: a second
        // failure is a real problem and must surface, not loop.
        const load = async () => {
          try {
            return await pdfjsLib.getDocument({ data: buf.slice(0) }).promise
          } catch (e: any) {
            const msg = String(e?.message || e)
            if (!/does not match the Worker version/i.test(msg)) throw e
            const wres = await fetch(
              `/pdf.worker.min.mjs?v=${pdfjsLib.version}`,
              { cache: 'reload' }
            )
            if (!wres.ok) throw e
            const blobUrl = URL.createObjectURL(
              new Blob([await wres.arrayBuffer()], { type: 'text/javascript' })
            )
            pdfjsLib.GlobalWorkerOptions.workerSrc = blobUrl
            try {
              return await pdfjsLib.getDocument({ data: buf.slice(0) }).promise
            } finally {
              URL.revokeObjectURL(blobUrl)
            }
          }
        }

        const pdf = await load()
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
      // A module Worker is a real thread; unmounting the viewer must stop it.
      if (workerRef.current) {
        try {
          workerRef.current.terminate()
        } catch {
          /* already gone */
        }
        workerRef.current = null
      }
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
