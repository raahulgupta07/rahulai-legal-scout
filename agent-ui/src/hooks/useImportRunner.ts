'use client'

/**
 * Drives the company-import queue: picks up the next queued file, streams the
 * extraction, then decides its fate without asking the operator anything.
 *
 * The decision is the whole point of the bulk flow. A DICA extract that yields
 * both a company name and a registration number is unambiguous and saves
 * itself. Anything short of that stops in the tray as `review`, and a
 * registration number already on file stops as `duplicate` rather than
 * silently overwriting a record someone may have hand-corrected.
 */

import { useCallback, useEffect, useRef } from 'react'
import apiClient, { authFetch } from '@/lib/api-client'
import { useImportQueue, type ImportItem } from './useImportQueue'

/** Coarse progress per stream stage — enough to show motion, not a lie. */
const STAGE_PROGRESS: Record<string, number> = {
  upload: 10,
  save: 18,
  parse: 35,
  ai: 65,
  warn: 70,
  done: 95,
}

const STAGE_LABEL: Record<string, string> = {
  upload: 'Uploading',
  save: 'Stored',
  parse: 'Reading PDF text',
  ai: 'Extracting with AI',
  warn: 'Extracting with AI',
}

/** Registration numbers already in the register, for duplicate detection. */
async function loadExistingRegNos(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const res = await authFetch(apiClient.getDashboardData())
    if (!res.ok) return map
    const body = await res.json()
    for (const c of body?.companies || []) {
      const reg = String(c.company_registration_number || '').trim()
      if (reg) map.set(reg, c.company_name || '')
    }
  } catch (e) {
    // A failed lookup must not block the batch — worst case a duplicate is
    // caught by the ON CONFLICT upsert instead of by us.
    console.error('Duplicate pre-check failed:', e)
  }
  return map
}

export function useImportRunner() {
  const items = useImportQueue((s) => s.items)
  const running = useImportQueue((s) => s.running)
  const update = useImportQueue((s) => s.update)
  const setRunning = useImportQueue((s) => s.setRunning)
  const takeFile = useImportQueue((s) => s.takeFile)
  const bumpSaved = useImportQueue((s) => s.bumpSaved)

  // Guards against two runners (or two renders) grabbing the same item.
  const busyRef = useRef(false)

  const processOne = useCallback(
    async (item: ImportItem) => {
      const file = takeFile(item.id)
      if (!file) {
        update(item.id, { status: 'failed', stage: 'File missing', error: 'File no longer available' })
        return
      }

      update(item.id, { status: 'uploading', stage: 'Uploading', progress: 5 })

      let extracted: any = null
      let pdfUrl: string | undefined

      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await authFetch(apiClient.extractCompanyPdfStream(), { method: 'POST', body: fd })
        if (!res.ok || !res.body) throw new Error(`Extraction failed (${res.status})`)

        update(item.id, { status: 'extracting', stage: 'Reading PDF text', progress: 20 })

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let finalEvt: any = null

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              const ev = JSON.parse(trimmed)
              if (ev.stage === 'done' || ev.stage === 'error') {
                finalEvt = ev
              } else {
                update(item.id, {
                  stage: STAGE_LABEL[ev.stage] || ev.msg || ev.stage,
                  progress: STAGE_PROGRESS[ev.stage] ?? item.progress,
                })
              }
            } catch {
              // A half-written ND-JSON line is normal mid-stream; skip it.
            }
          }
        }

        if (finalEvt?.stage !== 'done' || !finalEvt.data) {
          throw new Error(finalEvt?.msg || 'Extraction returned nothing')
        }
        extracted = finalEvt.data
        pdfUrl = finalEvt.pdf_url
      } catch (e: any) {
        update(item.id, {
          status: 'failed',
          stage: 'Failed',
          progress: 100,
          error: e?.message || 'Extraction failed',
        })
        return
      }

      const name = String(extracted.company_name_english || '').trim()
      const reg = String(extracted.company_registration_number || '').trim()
      const directors = Array.isArray(extracted.directors) ? extracted.directors.length : 0
      const members = Array.isArray(extracted.members) ? extracted.members.length : 0

      extracted.directors = extracted.directors || []
      extracted.members = extracted.members || []
      extracted.filing_history = extracted.filing_history || []
      if (pdfUrl) extracted.pdf_url = pdfUrl

      // Not enough to identify the company — never guess, park it for review.
      if (!name || !reg) {
        update(item.id, {
          status: 'review',
          stage: !name ? 'No company name found' : 'No registration number found',
          progress: 100,
          companyName: name || undefined,
          regNo: reg || undefined,
          data: extracted,
          pdfUrl,
          directors,
          members,
        })
        return
      }

      const existing = await loadExistingRegNos()
      if (existing.has(reg)) {
        update(item.id, {
          status: 'duplicate',
          stage: `Already on file as ${existing.get(reg) || reg}`,
          progress: 100,
          companyName: name,
          regNo: reg,
          data: extracted,
          pdfUrl,
          directors,
          members,
        })
        return
      }

      update(item.id, { status: 'saving', stage: 'Saving to register', progress: 96, companyName: name })

      try {
        const res = await authFetch(apiClient.addCompany(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(extracted),
        })
        if (!res.ok) throw new Error(`Save failed (${res.status})`)
        const body = await res.json()
        if (!body?.success) throw new Error(body?.error || 'Save failed')

        update(item.id, {
          status: 'saved',
          stage: 'Saved',
          progress: 100,
          companyName: name,
          regNo: reg,
          directors,
          members,
          pdfUrl,
        })
        bumpSaved()
      } catch (e: any) {
        update(item.id, {
          status: 'review',
          stage: 'Extracted but not saved',
          progress: 100,
          companyName: name,
          regNo: reg,
          data: extracted,
          pdfUrl,
          directors,
          members,
          error: e?.message || 'Save failed',
        })
      }
    },
    [takeFile, update, bumpSaved]
  )

  useEffect(() => {
    if (busyRef.current) return
    const next = items.find((i) => i.status === 'queued')
    if (!next) {
      if (running) setRunning(false)
      return
    }

    busyRef.current = true
    if (!running) setRunning(true)
    processOne(next).finally(() => {
      busyRef.current = false
      // Nudge the effect so the next queued file is picked up.
      update(next.id, {})
    })
  }, [items, running, processOne, setRunning, update])
}
