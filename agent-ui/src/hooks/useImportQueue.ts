'use client'

/**
 * Bulk company-extract queue.
 *
 * The legal team drops a stack of DICA extracts and expects the register to
 * fill itself — not to open and confirm each PDF in turn. This store owns that
 * batch: one entry per file, each moving through upload → extract → save, with
 * the live stage text the tray renders.
 *
 * It lives outside React's tree (a plain zustand store, mounted once by
 * AppShell) so the run survives navigating between Templates, Companies and
 * People. Closing the tray hides it; it does not cancel the batch.
 *
 * Files run ONE AT A TIME on purpose. Extraction is a long AI call against a
 * whole PDF, and firing ten in parallel buys nothing but rate-limit errors and
 * a progress display nobody can read.
 */

import { create } from 'zustand'

export type ImportStatus =
  | 'queued'
  | 'uploading'
  | 'extracting'
  | 'saving'
  | 'saved'
  | 'review'
  | 'duplicate'
  | 'failed'

export interface ImportItem {
  id: string
  fileName: string
  status: ImportStatus
  /** Human-readable current step, e.g. "Reading page 3/7". */
  stage: string
  /** 0-100, coarse — derived from which stage the stream is in. */
  progress: number
  /** Set once extraction returns; used by Open and by the duplicate prompt. */
  companyName?: string
  regNo?: string
  /** Populated on `review` / `duplicate` so the row can be opened or merged. */
  data?: any
  pdfUrl?: string
  error?: string
  /** Counts shown on a saved row. */
  directors?: number
  members?: number
}

interface ImportQueueState {
  items: ImportItem[]
  running: boolean
  open: boolean
  collapsed: boolean
  /** Bumped whenever a company is written, so lists can refetch. */
  savedTick: number
  enqueue: (files: File[]) => void
  update: (id: string, patch: Partial<ImportItem>) => void
  remove: (id: string) => void
  clearFinished: () => void
  setOpen: (open: boolean) => void
  setCollapsed: (collapsed: boolean) => void
  setRunning: (running: boolean) => void
  bumpSaved: () => void
  /** Files are kept out of the store — they are not serialisable state. */
  takeFile: (id: string) => File | undefined
  putFile: (id: string, file: File) => void
}

// Raw File objects sit beside the store rather than inside it: they are large,
// non-serialisable, and nothing in the UI needs to re-render when they change.
const fileBucket = new Map<string, File>()

let seq = 0
const nextId = () => `imp_${Date.now().toString(36)}_${seq++}`

export const useImportQueue = create<ImportQueueState>((set) => ({
  items: [],
  running: false,
  open: false,
  collapsed: false,
  savedTick: 0,

  enqueue: (files) => {
    const added: ImportItem[] = files.map((f) => {
      const id = nextId()
      fileBucket.set(id, f)
      return { id, fileName: f.name, status: 'queued', stage: 'Queued', progress: 0 }
    })
    set((s) => ({ items: [...s.items, ...added], open: true, collapsed: false }))
  },

  update: (id, patch) =>
    set((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) })),

  remove: (id) => {
    fileBucket.delete(id)
    set((s) => ({ items: s.items.filter((it) => it.id !== id) }))
  },

  clearFinished: () =>
    set((s) => {
      const keep = s.items.filter(
        (it) => !['saved', 'failed', 'duplicate', 'review'].includes(it.status)
      )
      s.items.forEach((it) => {
        if (!keep.includes(it)) fileBucket.delete(it.id)
      })
      return { items: keep, open: keep.length > 0 }
    }),

  setOpen: (open) => set({ open }),
  setCollapsed: (collapsed) => set({ collapsed }),
  setRunning: (running) => set({ running }),
  bumpSaved: () => set((s) => ({ savedTick: s.savedTick + 1 })),

  takeFile: (id) => fileBucket.get(id),
  putFile: (id, file) => {
    fileBucket.set(id, file)
  },
}))

/** Counts for the tray footer. */
export const importSummary = (items: ImportItem[]) => ({
  total: items.length,
  saved: items.filter((i) => i.status === 'saved').length,
  running: items.filter((i) => ['uploading', 'extracting', 'saving'].includes(i.status)).length,
  queued: items.filter((i) => i.status === 'queued').length,
  review: items.filter((i) => i.status === 'review' || i.status === 'duplicate').length,
  failed: items.filter((i) => i.status === 'failed').length,
})
