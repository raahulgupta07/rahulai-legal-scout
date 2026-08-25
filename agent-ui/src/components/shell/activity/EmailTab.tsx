'use client'

/**
 * Email channel of the activity tray — mail the agent composed and queued,
 * waiting on a person.
 *
 * The recipient and the attachment are shown in full and never truncated: they
 * are the two facts that decide whether sending is safe, and a clipped address
 * is exactly the one that gets approved by accident. Sending is irreversible,
 * so Send asks once before it goes.
 */

import { useState } from 'react'
import { Mail, Paperclip } from 'lucide-react'
import { toast } from 'sonner'
import apiClient, { authFetch } from '@/lib/api-client'
import { useEmailQueue, refreshEmailQueue } from '@/hooks/useEmailQueue'

export default function EmailTab() {
  const items = useEmailQueue((s) => s.items)
  const busy = useEmailQueue((s) => s.busy)
  const setBusy = useEmailQueue((s) => s.setBusy)
  const drop = useEmailQueue((s) => s.drop)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  if (items.length === 0) {
    return (
      <p className="px-3.5 py-6 text-center text-[11.5px] text-[var(--text-muted)]">
        Nothing waiting. Email the agent composes appears here for you to approve.
      </p>
    )
  }

  const act = async (id: number, kind: 'send' | 'discard') => {
    setBusy(id, true)
    try {
      const url = kind === 'send' ? apiClient.emailQueuedSend(id) : apiClient.emailQueuedDiscard(id)
      const res = await authFetch(url, { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (!res.ok || body?.success === false) {
        throw new Error(body?.detail || body?.error || `Could not ${kind} (${res.status})`)
      }
      toast.success(kind === 'send' ? 'Email sent' : 'Email discarded')
      drop(id)
      refreshEmailQueue()
    } catch (e: any) {
      console.error(`Email ${kind} failed:`, e)
      toast.error(e?.message || `Could not ${kind} the email`)
      setBusy(id, false)
    } finally {
      setConfirmId(null)
    }
  }

  return (
    <>
      {items.map((it) => {
        const locked = busy.includes(it.id)
        return (
          <div key={it.id} className="border-b border-[var(--border)] px-3.5 py-2.5 last:border-b-0">
            <div className="flex items-start gap-2">
              <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warn)]" />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-[var(--text)]">{it.subject || '(no subject)'}</p>
                {/* Deliberately wrapped, not truncated — the address is the decision. */}
                <p className="mt-0.5 break-all text-[11.5px] text-[var(--text-muted)]">To: {it.to_email}</p>
                {it.attachment_name && (
                  <p className="mt-0.5 flex items-start gap-1 break-all text-[11.5px] text-[var(--text-muted)]">
                    <Paperclip className="mt-0.5 h-3 w-3 shrink-0" />
                    {it.attachment_name}
                  </p>
                )}

                {confirmId === it.id ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-[var(--text)]">Send now? It cannot be recalled.</span>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => act(it.id, 'send')}
                      className="rounded border border-[var(--border-strong,var(--border))] px-2 py-0.5 text-[11px] font-medium text-[var(--danger-strong,#b91c1c)] hover:bg-[var(--accent)] disabled:opacity-50"
                    >
                      {locked ? 'Sending…' : 'Yes, send'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      className="rounded px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-[var(--text)]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => setConfirmId(it.id)}
                      className="rounded border border-[var(--border-strong,var(--border))] px-2 py-0.5 text-[11px] font-medium text-[var(--text)] hover:bg-[var(--accent)] disabled:opacity-50"
                    >
                      Send
                    </button>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => act(it.id, 'discard')}
                      className="rounded px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50"
                    >
                      Discard
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
