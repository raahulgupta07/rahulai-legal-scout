'use client'

import { useState } from 'react'

import type { ToolCall } from '@/types/os'

/**
 * The approval step for an email the agent composed.
 *
 * send_email_tool no longer sends. It writes the email to email_logs with
 * status 'queued' and returns it here, and the only path to SMTP is
 * POST /api/email/queued/{id}/send, which requires the signed-in user's JWT.
 * The agent has no session and no token, so it cannot take this step on its own
 * — which is the point. An approval the agent could grant itself would not be
 * an approval.
 *
 * The recipient and the attachment are shown in full and never truncated: they
 * are the two things that decide whether sending is safe, and email cannot be
 * recalled once it leaves.
 */
type Queued = {
  email_id: number
  to_email: string
  subject: string
  attachment_name?: string
}

const parseQueued = (call: ToolCall): Queued | null => {
  if (call.tool_name !== 'send_email_tool' || !call.result) return null
  try {
    const r = JSON.parse(call.result)
    if (!r?.queued || typeof r.email_id !== 'number') return null
    return {
      email_id: r.email_id,
      to_email: String(r.to_email ?? ''),
      subject: String(r.subject ?? ''),
      attachment_name: r.attachment_name ? String(r.attachment_name) : ''
    }
  } catch {
    return null
  }
}

const QueuedEmailCard = ({ toolCalls }: { toolCalls?: ToolCall[] }) => {
  const [done, setDone] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState('')

  const queued = (toolCalls ?? []).map(parseQueued).filter(Boolean) as Queued[]
  if (!queued.length) return null

  const act = async (id: number, action: 'send' | 'discard') => {
    setBusy(id)
    setError('')
    try {
      const token =
        typeof window !== 'undefined' ? localStorage.getItem('ls_token') : ''
      const res = await fetch(`/api/email/queued/${id}/${action}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        // Say what went wrong rather than showing a card that silently does
        // nothing — the user has no other way to tell whether it went out.
        setError(data.detail || data.error || `Could not ${action} the email.`)
        return
      }
      setDone((prev) => ({
        ...prev,
        [id]: action === 'send' ? 'Sent' : 'Discarded'
      }))
    } catch {
      setError('Could not reach the server. The email has not been sent.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      aria-label="Email waiting for approval"
      data-queued-email=""
      className="mt-3 flex flex-col gap-2"
    >
      {queued.map((mail) => (
        <div
          key={mail.email_id}
          className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3.5 py-3"
        >
          <p className="text-[11px] uppercase tracking-[0.05em] text-[var(--text-muted)]">
            Not sent — needs your approval
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] leading-[1.5]">
            <dt className="text-[var(--text-muted)]">To</dt>
            <dd className="break-all font-medium text-[var(--text)]">
              {mail.to_email}
            </dd>
            <dt className="text-[var(--text-muted)]">Subject</dt>
            <dd className="text-[var(--text)]">{mail.subject || '(none)'}</dd>
            {mail.attachment_name ? (
              <>
                <dt className="text-[var(--text-muted)]">Attachment</dt>
                <dd className="break-all text-[var(--text)]">
                  {mail.attachment_name}
                </dd>
              </>
            ) : null}
          </dl>

          {done[mail.email_id] ? (
            <p className="mt-2.5 text-[13px] font-medium text-[var(--text)]">
              {done[mail.email_id]}.
            </p>
          ) : (
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy === mail.email_id}
                onClick={() => act(mail.email_id, 'send')}
                className="cursor-pointer rounded-[var(--radius-xl)] bg-[var(--brand)] px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                {busy === mail.email_id ? 'Sending…' : 'Send'}
              </button>
              <button
                type="button"
                disabled={busy === mail.email_id}
                onClick={() => act(mail.email_id, 'discard')}
                className="cursor-pointer rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[13px] text-[var(--text)] transition-colors hover:border-[var(--text-muted)] disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                Discard
              </button>
            </div>
          )}
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-[13px] text-[var(--danger, #DC2626)]">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export default QueuedEmailCard
