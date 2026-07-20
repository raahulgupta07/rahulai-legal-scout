import MarkdownRenderer from '@/components/ui/typography/MarkdownRenderer'
import { useStore } from '@/store'
import type { ChatMessage } from '@/types/os'
import Videos from './Multimedia/Videos'
import Images from './Multimedia/Images'
import Audios from './Multimedia/Audios'
import { memo, useState, useEffect } from 'react'
import { DocumentCards } from '@/components/ui/DocumentViewer'
import { Mail, Send, Paperclip, Loader2 } from 'lucide-react'
import { authFetch } from '@/lib/api-client'

interface MessageProps {
  message: ChatMessage
}

function extractDocuments(content: string): Array<{fileName: string, downloadUrl: string, previewUrl?: string}> {
  const documents = []
  
  const downloadUrlRegex = /Download URL:\s*(https?:\/\/[^\s]+)/gi
  const previewUrlRegex = /Preview URL:\s*(https?:\/\/[^\s]+)/gi
  const fileNameRegex = /(?:File|📄)\s*:\s*([^\n]+)/gi
  
  let downloadMatch
  let previewMatch
  let fileNameMatch
  
  const downloadUrls: string[] = []
  const previewUrls: string[] = []
  const fileNames: string[] = []
  
  while ((downloadMatch = downloadUrlRegex.exec(content)) !== null) {
    downloadUrls.push(downloadMatch[1])
  }
  
  while ((previewMatch = previewUrlRegex.exec(content)) !== null) {
    previewUrls.push(previewMatch[1])
  }
  
  while ((fileNameMatch = fileNameRegex.exec(content)) !== null) {
    fileNames.push(fileNameMatch[1].trim())
  }
  
  for (let i = 0; i < downloadUrls.length; i++) {
    const url = downloadUrls[i]
    const fileName = fileNames[i] || url.split('/').pop() || 'document.docx'
    const previewUrl = previewUrls[i]
    
    documents.push({
      fileName,
      downloadUrl: url,
      previewUrl
    })
  }
  
  return documents
}

/*
  There is deliberately no a) / b) / c) option parser here.

  An earlier version scanned the agent's prose for lettered options and
  rendered them as buttons, stripping the same lines out of the displayed
  text. The client rejected lettered lists outright — "no different from
  filling manually" — so a person is only ever chosen from the in-chat
  picker card, which carries a real candidate list and a confirmed
  selection. Parsing prose back into buttons re-created the rejected
  interaction on the client side and hid the original text while doing it.

  If the agent still emits a lettered list somewhere, it now renders as
  ordinary prose: visible to the reader, but not dressed up as a control.
*/

// Detect missing fields pattern from AI response
function extractMissingFields(content: string): string[] {
  const fields: string[] = []
  // Match patterns like "- company\n- director_name\n" or "company:\ndir_name:"
  const lines = content.split('\n')
  let inFieldSection = false

  for (const line of lines) {
    const trimmed = line.trim()
    // Detect start of field list
    if (/missing|need these|provide.*details|required|please.*provide/i.test(trimmed)) {
      inFieldSection = true
      continue
    }
    // Detect field lines: "- field_name" or "field_name:" or "• field_name"
    if (inFieldSection) {
      const match = trimmed.match(/^[-•*]\s*(.+?)(?:\s*:.*)?$/) || trimmed.match(/^([a-z_]+(?:\s*[a-z_]+)*)(?:\s*:)?\s*$/i)
      if (match) {
        const field = match[1].trim().replace(/:$/, '')
        // Filter out non-field lines
        if (field.length > 1 && field.length < 40 && !/already|database|have|send|format|like|what/i.test(field)) {
          fields.push(field)
        }
      }
      // Stop when hitting empty line or different section
      if (trimmed === '' && fields.length > 0) {
        // Check if next lines are still fields
        continue
      }
      if (/already|database|have:|if you/i.test(trimmed) && fields.length > 0) {
        break
      }
    }
  }
  return fields.length >= 2 ? fields : []
}

// Interactive form for missing fields
function MissingFieldsForm({ fields, onSubmit }: { fields: string[]; onSubmit: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>({})

  const handleSubmit = () => {
    // Build message with all field values
    const filled = Object.entries(values).filter(([_, v]) => v.trim())
    if (filled.length === 0) return
    onSubmit(values)
  }

  const formatLabel = (field: string) => {
    return field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }

  return (
    <div className="mt-3 max-w-lg overflow-hidden border border-[var(--border)] bg-[var(--surface)] rounded-[var(--radius-xl)]">
      <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
        <p className="font-[family-name:var(--font-display)] text-[length:var(--text-sm)] font-semibold text-[var(--text)]">
          Fill missing information
        </p>
        <p className="mt-0.5 text-[length:var(--text-xs)] text-[var(--text-muted)]">
          Complete the fields below and submit to generate
        </p>
      </div>
      <div className="space-y-3 p-4">
        {fields.map((field) => (
          <div key={field}>
            <label className="mb-1 block text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)]">
              {formatLabel(field)}
            </label>
            <input
              type={/date|birth/.test(field) ? 'date' : /email/.test(field) ? 'email' : /phone/.test(field) ? 'tel' : 'text'}
              placeholder={`Enter ${formatLabel(field).toLowerCase()}`}
              value={values[field] || ''}
              onChange={(e) => setValues(prev => ({ ...prev, [field]: e.target.value }))}
              className="w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[length:var(--text-sm)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--brand)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            />
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
        <button
          onClick={handleSubmit}
          className="flex items-center gap-1.5 rounded-[var(--radius-xl)] bg-[var(--brand)] px-4 py-2 text-[length:var(--text-sm)] font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]"
        >
          Submit &amp; generate
        </button>
      </div>
    </div>
  )
}

// Detect if message is about email sending — show composer form
function isEmailRelated(content: string): boolean {
  return /email.*not configured|smtp.*not.*configured|can't send.*email|couldn't send.*email|email isn't configured|set up.*smtp|configure.*smtp|send.*email.*to|recipient.*email|email.*address|email.*subject|email.*body|email.*message|I can send|I can email|send it.*email|attach.*document/i.test(content)
}

// Extract email address from message
function extractEmailAddress(content: string): string {
  const match = content.match(/[\w.-]+@[\w.-]+\.\w+/)
  return match ? match[0] : ""
}

// Extract document filename from message
function extractDocFilename(content: string): string {
  const match = content.match(/[\w_-]+\.docx/i)
  return match ? match[0] : ""
}

// Inline Email Composer shown in chat
function InlineEmailComposer({ defaultTo, defaultAttachment, onSent }: { defaultTo: string; defaultAttachment?: string; onSent: () => void }) {
  const [to, setTo] = useState(defaultTo)
  const [subject, setSubject] = useState(defaultAttachment ? `Document: ${defaultAttachment}` : "Document from Legal Scout")
  const [message, setMessage] = useState("")
  const [attachment, setAttachment] = useState(defaultAttachment || "")
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [docs, setDocs] = useState<string[]>([])

  useEffect(() => {
    authFetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/dashboard/data`)
      .then(r => r.json())
      .then(data => setDocs((data.documents || []).slice(0, 10).map((d: any) => d.file_name)))
      .catch(() => {})
  }, [])

  if (sent) {
    return (
      <div className="mt-3 flex max-w-lg items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--ok)] bg-[var(--surface)] p-4 text-[length:var(--text-sm)] text-[var(--text)]">
        <Mail className="h-4 w-4 shrink-0 text-[var(--ok-strong)]" /> Email sent to {to}
      </div>
    )
  }

  const handleSend = async () => {
    if (!to) return
    setSending(true)
    try {
      const res = await authFetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/documents/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_email: to, subject, message: message || "Please find the attached document.",
          file_path: attachment ? `/documents/legal/output/${attachment}` : "",
        }),
      })
      const data = await res.json()
      if (data.success) { setSent(true); onSent() }
      else { alert(data.error || "Failed to send") }
    } catch { alert("Failed to send") }
    finally { setSending(false) }
  }

  return (
    <div className="mt-3 max-w-lg overflow-hidden border border-[var(--border)] bg-[var(--surface)] rounded-[var(--radius-xl)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5">
        <div className="flex items-center gap-2 text-[var(--text)]">
          <Mail className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="font-[family-name:var(--font-display)] text-[length:var(--text-sm)] font-semibold">Email</span>
        </div>
        <button onClick={handleSend} disabled={sending || !to}
          className="flex items-center gap-1.5 rounded-[var(--radius-xl)] bg-[var(--brand)] px-3 py-1.5 text-[length:var(--text-xs)] font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]">
          {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="divide-y divide-[var(--border)]">
        <div className="flex items-center gap-2 px-4 py-2">
          <span className="w-16 shrink-0 text-[length:var(--text-xs)] text-[var(--text-muted)]">To</span>
          <input value={to} onChange={e => setTo(e.target.value)} placeholder="email@example.com" type="email"
            className="flex-1 bg-transparent text-[length:var(--text-sm)] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
        </div>
        <div className="flex items-center gap-2 px-4 py-2">
          <span className="w-16 shrink-0 text-[length:var(--text-xs)] text-[var(--text-muted)]">Subject</span>
          <input value={subject} onChange={e => setSubject(e.target.value)}
            className="flex-1 bg-transparent text-[length:var(--text-sm)] text-[var(--text)] outline-none" />
        </div>
        <div className="flex items-center gap-2 px-4 py-2">
          <span className="flex w-16 shrink-0 items-center gap-1 text-[length:var(--text-xs)] text-[var(--text-muted)]">
            <Paperclip className="h-3 w-3" /> File
          </span>
          <select value={attachment} onChange={e => setAttachment(e.target.value)}
            className="flex-1 bg-transparent text-[length:var(--text-sm)] text-[var(--text)] outline-none">
            <option value="">No attachment</option>
            {docs.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="px-4 py-2">
          <textarea value={message} onChange={e => setMessage(e.target.value)}
            placeholder="Write your message…" rows={3}
            className="w-full resize-none bg-transparent text-[length:var(--text-sm)] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
        </div>
      </div>
    </div>
  )
}

const AgentMessage = ({ message }: MessageProps) => {
  const { streamingErrorMessage, setPendingMessage } = useStore()

  const documents = message.content ? extractDocuments(message.content) : []
  const missingFields = message.content ? extractMissingFields(message.content) : []
  const showEmailForm = message.content ? isEmailRelated(message.content) : false
  const emailTo = message.content ? extractEmailAddress(message.content) : ""
  const emailAttachment = message.content ? extractDocFilename(message.content) : ""

  const handleFieldsSubmit = (values: Record<string, string>) => {
    const lines = Object.entries(values)
      .filter(([_, v]) => v.trim())
      .map(([k, v]) => `${k}: ${v}`)
    if (lines.length > 0) {
      setPendingMessage("Use these values as custom_data and generate the document now:\n" + lines.join("\n"))
    }
  }

  const displayContent = message.content

  let messageContent
  if (message.streamingError) {
    messageContent = (
      <p className="text-[length:var(--text-sm)] text-[var(--danger-strong)]">
        Something went wrong while streaming.{' '}
        {streamingErrorMessage ? (
          <>{streamingErrorMessage}</>
        ) : (
          'Please try refreshing the page or try again later.'
        )}
      </p>
    )
  } else if (displayContent) {
    messageContent = (
      <div className="flex w-full flex-col gap-4">
        {/* ~65ch keeps prose at a comfortable reading measure; cards and
            attachments below are free to use the full column width. */}
        <div className="max-w-[65ch]">
          <MarkdownRenderer>{displayContent}</MarkdownRenderer>
        </div>
        {showEmailForm ? (
          <InlineEmailComposer defaultTo={emailTo} defaultAttachment={emailAttachment} onSent={() => {}} />
        ) : missingFields.length > 0 ? (
          <MissingFieldsForm fields={missingFields} onSubmit={handleFieldsSubmit} />
        ) : null}
        {documents.length > 0 && (
          <DocumentCards documents={documents} />
        )}
        {message.videos && message.videos.length > 0 && (
          <Videos videos={message.videos} />
        )}
        {message.images && message.images.length > 0 && (
          <Images images={message.images} />
        )}
        {message.audio && message.audio.length > 0 && (
          <Audios audio={message.audio} />
        )}
      </div>
    )
  } else if (message.response_audio) {
    if (!message.response_audio.transcript) {
      return null
    } else {
      messageContent = (
        <div className="flex w-full flex-col gap-4">
          <div className="max-w-[65ch]">
            <MarkdownRenderer>
              {message.response_audio.transcript}
            </MarkdownRenderer>
          </div>
          {message.response_audio.content && message.response_audio && (
            <Audios audio={[message.response_audio]} />
          )}
        </div>
      )
    }
  } else {
    // No content yet — return null so the answer box is hidden
    // (the CLI block in AgentMessageWrapper already shows the loading state)
    return null
  }

  return (
    <div className="font-[family-name:var(--font-body)] text-[length:var(--text-base)] leading-relaxed text-[var(--text)]">
      {messageContent}
    </div>
  )
}

const UserMessage = memo(({ message }: MessageProps) => {
  return (
    <div className="flex justify-end max-md:break-words">
      {/* The user turn is the one inverted surface in the thread — it reads as
          an utterance, while agent output reads as a document. */}
      <div className="max-w-[80%] rounded-[var(--radius-xl)] bg-[var(--surface-inverse)] px-4 py-2.5 text-[var(--text-inverse)]">
        <p className="whitespace-pre-wrap font-[family-name:var(--font-body)] text-[length:var(--text-sm)] leading-relaxed">
          {message.content}
        </p>
      </div>
    </div>
  )
})

AgentMessage.displayName = 'AgentMessage'
UserMessage.displayName = 'UserMessage'
export { AgentMessage, UserMessage }
