'use client'

/**
 * Email the agent has composed and QUEUED, waiting for a person to decide.
 *
 * The agent cannot send — it has no session and no token — so a queued email
 * sits there until someone approves it. That makes it pending work, and
 * pending work belongs in the tray with everything else; a queue nobody looks
 * at is the same as no queue.
 *
 * Polled slowly. Nothing here moves on its own: the count only changes when
 * the agent queues one or the operator decides on one.
 */

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import apiClient, { authFetch } from '@/lib/api-client'

const POLL_MS = 30000

export interface QueuedEmail {
  id: number
  to_email: string
  subject: string
  body: string
  attachment_name?: string | null
  created_at?: string | null
}

interface EmailQueueState {
  items: QueuedEmail[]
  /** Ids currently being sent or discarded, so the row can lock its buttons. */
  busy: number[]
  setItems: (items: QueuedEmail[]) => void
  setBusy: (id: number, busy: boolean) => void
  drop: (id: number) => void
}

export const useEmailQueue = create<EmailQueueState>((set) => ({
  items: [],
  busy: [],
  setItems: (items) => set({ items }),
  setBusy: (id, busy) =>
    set((s) => ({ busy: busy ? [...s.busy, id] : s.busy.filter((x) => x !== id) })),
  drop: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id), busy: s.busy.filter((x) => x !== id) })),
}))

export async function refreshEmailQueue() {
  try {
    const res = await authFetch(apiClient.emailQueued())
    if (!res.ok) return
    const body = await res.json()
    useEmailQueue.getState().setItems(Array.isArray(body?.queued) ? body.queued : [])
  } catch (e) {
    console.error('Queued-email poll failed:', e)
  }
}

/** Single poller for the whole app. Mount from the tray only. */
export function useEmailQueuePoller() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    refreshEmailQueue()
    timerRef.current = setInterval(refreshEmailQueue, POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])
}
