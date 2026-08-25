import { useEffect, useRef, useState } from 'react'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
import { toast } from 'sonner'
import { authFetch } from '@/lib/api-client'

/**
 * Thumbs up / thumbs down on an agent turn.
 *
 * The vote is stored server-side against the signed-in user; the identity is
 * taken from the bearer token, never sent from here. Storing it is the whole
 * job — nothing in this file feeds a model, a prompt or a retrieval step.
 *
 * ★ The endpoint may not exist yet. Legal Scout's frontend catch-all
 * (`@app.get("/{full_path:path}")`) answers an unknown GET with the Next.js
 * shell at HTTP **200**, so `res.ok` is not evidence the API is there — the
 * content type is. Everything below treats a non-JSON answer as "no feedback
 * API", once, quietly, rather than as a failure to shout about.
 */

export type FeedbackVote = 'up' | 'down'

const FEEDBACK_URL = `${process.env.NEXT_PUBLIC_API_URL || ''}/api/feedback`

type VoteMap = Record<string, FeedbackVote>

/**
 * One GET per session, shared by every message in it. A per-message fetch
 * would be one request per bubble on every history load.
 */
const sessionVotes = new Map<string, Promise<VoteMap>>()

/**
 * Latched the first time a request proves there is no feedback API. It stops
 * the transcript re-asking on every mount; it deliberately does NOT hide the
 * buttons, because a click still gets an honest error rather than silence.
 */
let apiMissing = false

/** A 200 carrying the frontend's HTML is not a JSON answer. See the note above. */
function isJson(res: Response): boolean {
  return (res.headers.get('content-type') || '').includes('application/json')
}

function asVote(value: unknown): FeedbackVote | null {
  return value === 'up' || value === 'down' ? value : null
}

/**
 * Tolerant of the response shape: a map keyed by message id, a `votes` /
 * `feedback` wrapper, or a plain array of rows. Anything unrecognised reads as
 * "no votes", which renders as no active button — never as a wrong one.
 */
function normaliseVotes(payload: unknown): VoteMap {
  const out: VoteMap = {}
  if (!payload || typeof payload !== 'object') return out

  const root = payload as Record<string, unknown>
  const rows =
    (Array.isArray(payload) && payload) ||
    (Array.isArray(root.feedback) && root.feedback) ||
    (Array.isArray(root.votes) && root.votes) ||
    (Array.isArray(root.data) && root.data) ||
    null

  if (rows) {
    for (const row of rows as Array<Record<string, unknown>>) {
      if (!row || typeof row !== 'object') continue
      const id = row.message_id ?? row.messageId ?? row.id
      const vote = asVote(row.vote ?? row.value)
      if (typeof id === 'string' && vote) out[id] = vote
    }
    return out
  }

  const map = (root.votes ?? root.feedback ?? root.data ?? payload) as Record<
    string,
    unknown
  >
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [id, value] of Object.entries(map)) {
      const vote = asVote(
        typeof value === 'string'
          ? value
          : (value as Record<string, unknown>)?.vote
      )
      if (vote) out[id] = vote
    }
  }
  return out
}

function loadSessionVotes(sessionId: string): Promise<VoteMap> {
  const cached = sessionVotes.get(sessionId)
  if (cached) return cached

  const request = authFetch(
    `${FEEDBACK_URL}?session_id=${encodeURIComponent(sessionId)}`
  )
    .then(async (res) => {
      if (!res.ok || !isJson(res)) {
        apiMissing = true
        return {} as VoteMap
      }
      return normaliseVotes(await res.json())
    })
    // A missing endpoint must not reach the console on every transcript load.
    .catch(() => {
      apiMissing = true
      return {} as VoteMap
    })

  sessionVotes.set(sessionId, request)
  return request
}

interface MessageFeedbackProps {
  /** Conversation the vote belongs to. Absent → nothing to store against. */
  sessionId?: string | null
  /** The run that produced this turn, when the message carries one. */
  runId?: string | null
  /** Stable identifier for this message within the session. */
  messageId: string
}

const BUTTON_CLASS =
  'inline-flex cursor-pointer items-center rounded-[var(--radius-xl)] px-2 py-1 ' +
  'text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text)] ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ' +
  'disabled:cursor-default disabled:opacity-50'

const MessageFeedback = ({
  sessionId,
  runId,
  messageId
}: MessageFeedbackProps) => {
  const [vote, setVote] = useState<FeedbackVote | null>(null)
  const [pending, setPending] = useState(false)
  // Once the reader has voted here, their choice outranks anything a late
  // GET resolves with — otherwise a slow response would overwrite the click.
  const touched = useRef(false)

  useEffect(() => {
    if (!sessionId || apiMissing) return
    let alive = true
    loadSessionVotes(sessionId).then((votes) => {
      if (!alive || touched.current) return
      setVote(votes[messageId] ?? null)
    })
    return () => {
      alive = false
    }
  }, [sessionId, messageId])

  // Two conditions, and a vote is unstorable-or-unreadable without either.
  //
  // `sessionId`: the server rejects a vote without one (400), and rightly —
  // GET is keyed on it, so such a row could never be read back.
  //
  // `runId`: this one is subtler and was measured, not guessed. A message
  // built by the live stream carries no run id, so it would be keyed
  // positionally and then re-keyed by run id once the transcript is
  // rehydrated. The vote is stored correctly under the first key and simply
  // never found under the second — so the reader sees an unrated answer they
  // remember rating, rates it again, and the store ends up holding TWO rows
  // for one answer, possibly disagreeing. For a signal whose whole purpose is
  // later learning, a contradictory pair is worse than a missing row.
  //
  // So the control appears on turns whose identity is stable, and stays away
  // from turns whose identity is about to change under it. This re-enables
  // itself with no change here the moment the stream handler sets `run_id`.
  if (!sessionId || !runId) return null

  const submit = async (next: FeedbackVote | null) => {
    if (pending) return
    const previous = vote
    touched.current = true
    // Optimistic: the button answers the click immediately. It is reverted
    // below if the write did not land — a vote that silently failed to save
    // is worse than no button at all.
    setVote(next)
    setPending(true)
    try {
      const res = await authFetch(FEEDBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No user id: the server takes the identity from the bearer token.
        body: JSON.stringify({
          // Both guaranteed strings: the component returns null without them.
          session_id: sessionId,
          run_id: runId,
          message_id: messageId,
          // null clears the vote — switching up→down is one call, not two.
          vote: next
        })
      })
      if (!res.ok || !isJson(res)) {
        apiMissing = true
        throw new Error(`feedback endpoint returned ${res.status}`)
      }
      const body = (await res.json()) as {
        success?: boolean
        error?: string
      } | null
      if (body && body.success === false)
        throw new Error(body.error || 'not saved')

      // Write through, so scrolling away and back shows what was stored.
      const cached = sessionVotes.get(sessionId)
      if (cached) {
        cached.then((votes) => {
          if (next) votes[messageId] = next
          else delete votes[messageId]
        })
      }
    } catch {
      setVote(previous)
      toast.error('Feedback not saved — please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="inline-flex items-center">
      <button
        type="button"
        onClick={() => submit(vote === 'up' ? null : 'up')}
        disabled={pending}
        aria-pressed={vote === 'up'}
        aria-label={
          vote === 'up' ? 'Remove good response rating' : 'Good response'
        }
        title="Good response"
        className={`${BUTTON_CLASS} ${vote === 'up' ? 'text-[var(--ok-strong)]' : ''}`}
      >
        <ThumbsUp
          aria-hidden
          className="h-3.5 w-3.5"
          fill={vote === 'up' ? 'currentColor' : 'none'}
        />
      </button>
      <button
        type="button"
        onClick={() => submit(vote === 'down' ? null : 'down')}
        disabled={pending}
        aria-pressed={vote === 'down'}
        aria-label={
          vote === 'down' ? 'Remove poor response rating' : 'Poor response'
        }
        title="Poor response"
        className={`${BUTTON_CLASS} ${vote === 'down' ? 'text-[var(--danger-strong)]' : ''}`}
      >
        <ThumbsDown
          aria-hidden
          className="h-3.5 w-3.5"
          fill={vote === 'down' ? 'currentColor' : 'none'}
        />
      </button>
    </div>
  )
}

export default MessageFeedback
