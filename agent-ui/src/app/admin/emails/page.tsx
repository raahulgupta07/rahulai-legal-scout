"use client"

import { useEffect, useMemo, useState } from "react"
import { Download, Mail, Paperclip, RefreshCw } from "lucide-react"
import { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import {
  Badge,
  Button,
  type Column,
  DataTable,
  DetailList,
  EmptyState,
  LoadingScreen,
  Modal,
  Notice,
  Page,
  PageBody,
  PageHeader,
  SearchInput,
  Segmented,
  StatRow,
  StatTile,
  Toolbar,
  dateSort,
  ensureOk,
  formatDateTime,
} from "@/components/ui/kit"

const API = process.env.NEXT_PUBLIC_API_URL || ""

interface EmailLog {
  id: number
  to: string
  subject: string
  body: string
  attachment: string | null
  attachment_path: string | null
  sent_by: string
  status: string
  error: string | null
  time: string | null
}

type Filter = "all" | "sent" | "failed"

export default function EmailsPage() {
  const [emails, setEmails] = useState<EmailLog[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [selected, setSelected] = useState<EmailLog | null>(null)

  useEffect(() => {
    fetchEmails()
  }, [])

  const fetchEmails = async () => {
    setRefreshing(true)
    setLoadError("")
    try {
      const res = await authFetch(`${API}/api/admin/emails?limit=200`)
      await ensureOk(res, "Failed to load emails")
      const data = await res.json()
      setEmails(data.emails || [])
    } catch (e: any) {
      console.error("Fetch emails error:", e)
      setLoadError(e?.message || "Failed to load emails")
      toast.error(e?.message || "Failed to load emails")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const stats = useMemo(() => {
    const sent = emails.filter((e) => e.status === "sent").length
    const withAttachment = emails.filter((e) => e.attachment).length
    return { total: emails.length, sent, failed: emails.length - sent, withAttachment }
  }, [emails])

  const term = searchTerm.trim().toLowerCase()
  const filtered = useMemo(() => {
    let rows = emails
    if (filter === "sent") rows = rows.filter((e) => e.status === "sent")
    if (filter === "failed") rows = rows.filter((e) => e.status !== "sent")
    if (term) {
      rows = rows.filter(
        (e) =>
          e.to?.toLowerCase().includes(term) ||
          e.subject?.toLowerCase().includes(term) ||
          e.sent_by?.toLowerCase().includes(term)
      )
    }
    return rows
  }, [emails, filter, term])

  if (loading) return <LoadingScreen label="Loading emails" />

  const columns: Column<EmailLog>[] = [
    {
      key: "status",
      header: "Status",
      width: "1%",
      sortValue: (e) => e.status,
      render: (e) =>
        e.status === "sent" ? (
          <Badge tone="ok" dot>
            Sent
          </Badge>
        ) : (
          <Badge tone="danger" dot>
            Failed
          </Badge>
        ),
    },
    {
      key: "time",
      header: "Date",
      sortValue: (e) => dateSort(e.time),
      render: (e) => <span className="tabular-nums whitespace-nowrap">{formatDateTime(e.time)}</span>,
    },
    {
      key: "to",
      header: "To",
      sortValue: (e) => e.to,
      render: (e) => <span className="font-medium text-[var(--text)]">{e.to}</span>,
    },
    {
      key: "subject",
      header: "Subject",
      sortValue: (e) => e.subject,
      render: (e) => <span className="block max-w-[280px] truncate">{e.subject || "—"}</span>,
    },
    {
      key: "attachment",
      header: "Attachment",
      hideBelow: "md",
      render: (e) =>
        e.attachment ? (
          <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
            <Paperclip className="w-3 h-3 shrink-0" />
            <span className="truncate max-w-[160px]">{e.attachment}</span>
          </span>
        ) : (
          <span className="text-[var(--text-muted)]">—</span>
        ),
    },
    {
      key: "sent_by",
      header: "Sent by",
      hideBelow: "lg",
      sortValue: (e) => e.sent_by,
      render: (e) => e.sent_by || "—",
    },
  ]

  return (
    <Page>
      <PageHeader
        title="Emails"
        meta={
          <>
            <Badge tone="neutral">{emails.length}</Badge>
            {stats.failed > 0 && (
              <Badge tone="danger" dot>
                {stats.failed} failed
              </Badge>
            )}
          </>
        }
        description="Every email the agent has sent, including delivery failures and their reasons."
        actions={
          <Button onClick={fetchEmails} loading={refreshing} icon={<RefreshCw className="w-4 h-4" />}>
            Refresh
          </Button>
        }
      />

      {emails.length > 0 && (
        <Toolbar>
          <SearchInput
            label="Search emails"
            placeholder="Recipient, subject or sender…"
            value={searchTerm}
            onChange={setSearchTerm}
          />
          <Segmented<Filter>
            label="Filter by delivery status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: stats.total },
              { value: "sent", label: "Sent", count: stats.sent, tone: "ok" },
              { value: "failed", label: "Failed", count: stats.failed, tone: "danger" },
            ]}
          />
          <span className="ml-auto text-[length:var(--text-xs)] text-[var(--text-muted)] tabular-nums">
            {filtered.length} of {emails.length}
          </span>
        </Toolbar>
      )}

      <PageBody className="space-y-4">
        {loadError && <Notice tone="danger" title="Could not load emails">{loadError}</Notice>}

        {emails.length === 0 ? (
          <EmptyState
            icon={<Mail className="w-4 h-4" />}
            title="No emails sent yet"
            description="Emails sent by the agent from chat will be logged here, with their attachments and any delivery errors."
          />
        ) : (
          <>
            <StatRow>
              <StatTile label="Emails" value={stats.total} />
              <StatTile label="Delivered" value={stats.sent} tone={stats.sent > 0 ? "ok" : undefined} />
              <StatTile
                label="Failed"
                value={stats.failed}
                tone={stats.failed > 0 ? "danger" : undefined}
                hint={stats.failed > 0 ? "Open a row for the reason" : "No delivery failures"}
              />
              <StatTile label="With attachment" value={stats.withAttachment} />
            </StatRow>

            <DataTable
              rows={filtered}
              columns={columns}
              rowKey={(e) => e.id}
              onRowClick={setSelected}
              caption="Sent emails"
              rowTone={(e) => (e.status === "sent" ? null : "var(--danger-strong)")}
              empty={
                <div className="py-2">
                  <p className="text-[length:var(--text-sm)] text-[var(--text)]">No emails match the filters.</p>
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      setSearchTerm("")
                      setFilter("all")
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              }
            />
          </>
        )}
      </PageBody>

      <Modal
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected?.subject || "Email"}
        description={selected ? `To ${selected.to}` : undefined}
        footer={
          selected?.attachment_path ? (
            <Button
              onClick={() => window.open(`${API}${selected.attachment_path}`, "_blank")}
              icon={<Download className="w-3.5 h-3.5" />}
            >
              Download attachment
            </Button>
          ) : undefined
        }
      >
        {selected && (
          <div className="space-y-3">
            {selected.error && (
              <Notice tone="danger" title="Delivery failed">
                {selected.error}
              </Notice>
            )}

            <DetailList
              items={[
                ["To", selected.to],
                ["Sent by", selected.sent_by],
                ["Sent at", formatDateTime(selected.time)],
                [
                  "Status",
                  selected.status === "sent" ? (
                    <Badge tone="ok" dot>
                      Sent
                    </Badge>
                  ) : (
                    <Badge tone="danger" dot>
                      Failed
                    </Badge>
                  ),
                ],
              ]}
            />

            {selected.attachment && (
              <p className="flex items-center gap-1.5 text-[length:var(--text-sm)] text-[var(--text-secondary)]">
                <Paperclip className="w-3.5 h-3.5" />
                {selected.attachment}
              </p>
            )}

            <div>
              <p className="mb-1 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                Body
              </p>
              <div className="p-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-sm)] text-[length:var(--text-sm)] text-[var(--text)] whitespace-pre-wrap">
                {selected.body || "No body content"}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </Page>
  )
}
