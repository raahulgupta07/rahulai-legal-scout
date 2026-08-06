"use client"

import { useEffect, useState, useMemo } from "react"
import { ArrowLeft, Download, Eye, FileText, Trash2 } from "lucide-react"
import apiClient, { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import DocViewer from "@/components/ui/DocViewer"
import {
  Badge,
  Button,
  Card,
  type Column,
  ConfirmButton,
  DataTable,
  DetailList,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingScreen,
  Notice,
  Page,
  PageBody,
  PageHeader,
  SearchInput,
  StatRow,
  StatTile,
  Toolbar,
  assertSuccess,
  dateSort,
  ensureOk,
  errorMessage,
  formatDateTime,
} from "@/components/ui/kit"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || ""

interface Document {
  id: string
  template_name: string
  company_name: string
  file_name: string
  download_url: string
  created_at: string
  user_name?: string
  user?: string
  created_by_email?: string
}

/** A placeholder left as TBD means the document went out incomplete. */
const isUnfilled = (v: unknown) =>
  v == null || String(v).trim() === "" || String(v).trim().toUpperCase() === "TBD"

export default function DocumentsView() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null)
  const [previewDetail, setPreviewDetail] = useState<any>(null)

  useEffect(() => {
    if (!previewDoc) {
      setPreviewDetail(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await authFetch(apiClient.documentDetail(previewDoc.id))
        await ensureOk(res, "Failed to load document detail")
        const json = await res.json()
        if (!cancelled) setPreviewDetail(json.data)
      } catch (e: any) {
        console.error("Document detail error:", e)
        if (!cancelled) toast.error(e?.message || "Failed to load document detail")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [previewDoc])

  useEffect(() => {
    fetchDocuments()
  }, [])

  const fetchDocuments = async () => {
    setLoadError("")
    try {
      const res = await authFetch(apiClient.getDashboardData())
      await ensureOk(res, "Failed to load documents")
      const data = await res.json()
      setDocuments(data.documents || [])
    } catch (e: any) {
      console.error("Fetch error:", e)
      setLoadError(e?.message || "Failed to load documents")
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    let rows = documents

    if (startDate || endDate) {
      rows = rows.filter((doc) => {
        if (!doc.created_at) return true
        const docDate = new Date(doc.created_at)
        const start = startDate ? new Date(startDate) : null
        const end = endDate ? new Date(endDate) : null
        // Inclusive of the whole end day, not midnight on it.
        if (end) end.setHours(23, 59, 59, 999)
        if (start && end) return docDate >= start && docDate <= end
        if (start) return docDate >= start
        if (end) return docDate <= end
        return true
      })
    }

    const q = searchQuery.trim().toLowerCase()
    if (q) {
      rows = rows.filter(
        (doc) =>
          doc.file_name?.toLowerCase().includes(q) ||
          doc.company_name?.toLowerCase().includes(q) ||
          doc.template_name?.toLowerCase().includes(q)
      )
    }

    return rows
  }, [documents, startDate, endDate, searchQuery])

  const stats = useMemo(() => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const last7 = documents.filter((d) => d.created_at && now - new Date(d.created_at).getTime() < 7 * day).length
    const companies = new Set(documents.map((d) => d.company_name).filter(Boolean)).size
    const templates = new Set(documents.map((d) => d.template_name).filter(Boolean)).size
    return { total: documents.length, last7, companies, templates }
  }, [documents])

  const hasActiveFilters = !!(startDate || endDate || searchQuery.trim())

  const clearFilters = () => {
    setStartDate("")
    setEndDate("")
    setSearchQuery("")
  }

  const handleDelete = async (doc: Document) => {
    try {
      const docRef = doc.id || encodeURIComponent(doc.file_name)
      const res = await authFetch(`${API_BASE_URL}/api/dashboard/document/${docRef}`, { method: "DELETE" })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to delete document"))
      await assertSuccess(res, "Failed to delete document")
      toast.success(`"${doc.file_name}" deleted`)
      setDocuments((prev) => prev.filter((d) => d.file_name !== doc.file_name))
      if (previewDoc?.file_name === doc.file_name) setPreviewDoc(null)
    } catch (e: any) {
      console.error("Delete error:", e)
      toast.error(e?.message || "Failed to delete document")
    }
  }

  const previewUrl = (fileName: string) =>
    `${API_BASE_URL}/api/documents/preview-pdf/${encodeURIComponent(fileName)}`

  const downloadUrl = (doc: Document) =>
    doc.download_url || `${API_BASE_URL}/documents/legal/output/${encodeURIComponent(doc.file_name)}`

  if (loading) return <LoadingScreen label="Loading documents" />

  // ── Preview ──
  if (previewDoc) {
    const tok = typeof window !== "undefined" ? localStorage.getItem("ls_token") || "" : ""
    const customData = previewDetail?.custom_data || {}
    const validation = previewDetail?.validation_result || {}
    const placeholders: Array<[string, any]> = Object.entries(customData)

    // ★ Count what the DOCUMENT is missing, not what the data bag is missing.
    //
    // This badge used to count TBD entries across custom_data, which is the
    // whole bag of values assembled for the fill — every alias, every field any
    // template might want — not the placeholders this template actually
    // renders. On a correct Commerce Ace resolution that read "10 placeholders
    // unfilled" while the stat cards directly below said Placeholders 9 /
    // Filled 9 / Unfilled 0 / Complete. Both were drawn from the same record;
    // the header simply asked a different question and phrased the answer as
    // though it were the same one.
    //
    // The ten were auditor_fee, auditor_name, the financial-year dates, the
    // share counts, and the member slots for positions this company does not
    // have — none of which appear in the document. A lawyer reading that badge
    // has every reason to distrust a document that is in fact complete.
    //
    // validation_result is the authority, and it is what the cards read. Fall
    // back to the old count only for records saved before it was stored.
    const validationUnfilled = validation?.unfilled ?? validation?.total_unfilled
    const unfilledCount =
      typeof validationUnfilled === "number"
        ? validationUnfilled
        : placeholders.filter(([, v]) => isUnfilled(v)).length

    return (
      <Page>
        <PageHeader
          back={
            <IconButton
              aria-label="Back to documents"
              onClick={() => setPreviewDoc(null)}
              icon={<ArrowLeft className="w-4 h-4" />}
            />
          }
          title={previewDoc.file_name}
          meta={
            unfilledCount > 0 ? (
              <Badge tone="warn" dot>
                {unfilledCount} placeholder{unfilledCount === 1 ? "" : "s"} unfilled
              </Badge>
            ) : placeholders.length > 0 ? (
              <Badge tone="ok" dot>
                Fully filled
              </Badge>
            ) : undefined
          }
          actions={
            <Button
              variant="primary"
              onClick={() => window.open(downloadUrl(previewDoc), "_blank")}
              icon={<Download className="w-3.5 h-3.5" />}
            >
              Download
            </Button>
          }
        />

        <div className="flex flex-1 min-h-0 split-view-mobile">
          <div className="w-1/2 flex flex-col min-w-0 border-r border-[var(--border)]">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
              <Eye className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <span className="text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)]">Preview</span>
            </div>
            <DocViewer
              url={`${previewUrl(previewDoc.file_name)}?token=${tok}`}
              forceFormat="pdf"
              className="flex-1 w-full"
            />
          </div>

          <div className="w-1/2 flex flex-col min-w-0 overflow-y-auto bg-[var(--bg-secondary)]">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
              <FileText className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <span className="text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)]">
                Placeholders & metadata
              </span>
            </div>

            <div className="p-4 space-y-3">
              <Card title="Provenance">
                <DetailList
                  items={[
                    ["Template", previewDoc.template_name],
                    ["Company", previewDoc.company_name],
                    ["Created", formatDateTime(previewDoc.created_at)],
                    ["Generated by", previewDoc.user_name || previewDoc.created_by_email || "—"],
                  ]}
                />
              </Card>

              {validation?.total_placeholders !== undefined && (() => {
                // The stored validation_result uses total_filled / total_unfilled
                // / is_valid; a derived summary (if ever stored) uses
                // filled_from_data / unfilled / validation_status. Read either,
                // so old and new records both populate — before this the cards
                // read only the summary keys and showed "—".
                const filled = validation.filled_from_data ?? validation.total_filled
                const unfilled = validation.unfilled ?? validation.total_unfilled
                const status =
                  validation.validation_status ??
                  (validation.is_valid === true
                    ? "Complete"
                    : validation.is_valid === false
                      ? "Partial"
                      : undefined)
                return (
                  <StatRow>
                    <StatTile label="Placeholders" value={validation.total_placeholders ?? "—"} />
                    <StatTile label="Filled" value={filled ?? "—"} tone="ok" />
                    <StatTile
                      label="Unfilled"
                      value={unfilled ?? "—"}
                      tone={typeof unfilled === "number" && unfilled > 0 ? "warn" : undefined}
                    />
                    <StatTile label="Status" value={status ?? "—"} />
                  </StatRow>
                )
              })()}

              <Card
                title="Placeholder values"
                meta={<Badge tone="neutral">{placeholders.length}</Badge>}
                padded={false}
              >
                {placeholders.length === 0 ? (
                  <p className="p-4 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                    No placeholder values were recorded for this document.
                  </p>
                ) : (
                  <DataTable
                    className="border-0 rounded-none"
                    rows={placeholders.map(([field, value]) => ({ field, value }))}
                    rowKey={(r: any) => r.field}
                    rowTone={(r: any) => (isUnfilled(r.value) ? "var(--warn)" : null)}
                    columns={[
                      {
                        key: "field",
                        header: "Field",
                        sortValue: (r: any) => r.field,
                        render: (r: any) => (
                          <span className="font-mono text-[var(--text-secondary)]">{`{{${r.field}}}`}</span>
                        ),
                      },
                      {
                        key: "value",
                        header: "Value",
                        render: (r: any) =>
                          isUnfilled(r.value) ? (
                            <Badge tone="warn">{String(r.value || "TBD")}</Badge>
                          ) : (
                            <span className="break-words">{String(r.value)}</span>
                          ),
                      },
                    ]}
                  />
                )}
              </Card>
            </div>
          </div>
        </div>
      </Page>
    )
  }

  // ── List ──
  const columns: Column<Document>[] = [
    {
      key: "created_at",
      header: "Created",
      sortValue: (d) => dateSort(d.created_at),
      render: (d) => (
        <span className="tabular-nums whitespace-nowrap">{formatDateTime(d.created_at)}</span>
      ),
    },
    {
      key: "file_name",
      header: "Document",
      sortValue: (d) => d.file_name,
      render: (d) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-sm)]">
            <FileText className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          </span>
          <span className="font-medium text-[var(--text)] truncate max-w-[320px]">{d.file_name}</span>
        </div>
      ),
    },
    {
      key: "company_name",
      header: "Company",
      sortValue: (d) => d.company_name,
      render: (d) => (
        <span className="block truncate max-w-[180px]">{d.company_name?.split("\n")[0] || "—"}</span>
      ),
    },
    {
      key: "template_name",
      header: "Template",
      hideBelow: "md",
      sortValue: (d) => d.template_name,
      render: (d) => <span className="block truncate max-w-[180px]">{d.template_name || "—"}</span>,
    },
    {
      key: "created_by_email",
      header: "By",
      hideBelow: "lg",
      sortValue: (d) => d.created_by_email,
      render: (d) => d.created_by_email || "—",
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "1%",
      stopClickPropagation: true,
      render: (d) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton
            aria-label={`Preview ${d.file_name}`}
            title="Preview"
            onClick={() => setPreviewDoc(d)}
            icon={<Eye className="w-3.5 h-3.5" />}
          />
          <IconButton
            aria-label={`Download ${d.file_name}`}
            title="Download"
            onClick={() => window.open(downloadUrl(d), "_blank")}
            icon={<Download className="w-3.5 h-3.5" />}
          />
          <ConfirmButton
            compact
            label={`Delete ${d.file_name}`}
            icon={<Trash2 className="w-3.5 h-3.5" />}
            onConfirm={() => handleDelete(d)}
          />
        </div>
      ),
    },
  ]

  return (
    <Page>
      <PageHeader
        title="Documents"
        meta={<Badge tone="neutral">{documents.length} generated</Badge>}
        description="Every document the agent has produced, with the values it used to fill each placeholder."
      />

      {documents.length > 0 && (
        <Toolbar className="gap-3">
          <SearchInput
            label="Search documents"
            placeholder="Document, company or template…"
            value={searchQuery}
            onChange={setSearchQuery}
          />
          <div className="flex items-end gap-2">
            <Field label="From" htmlFor="doc-from" className="w-36">
              <Input id="doc-from" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
            <Field label="To" htmlFor="doc-to" className="w-36">
              <Input id="doc-to" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </Field>
            {hasActiveFilters && (
              <Button size="sm" variant="ghost" onClick={clearFilters} className="mb-1">
                Clear
              </Button>
            )}
          </div>
          <span className="ml-auto self-center text-[length:var(--text-xs)] text-[var(--text-muted)] tabular-nums">
            {filtered.length} of {documents.length}
          </span>
        </Toolbar>
      )}

      <PageBody className="space-y-4">
        {loadError && <Notice tone="danger" title="Could not load documents">{loadError}</Notice>}

        {documents.length === 0 ? (
          <EmptyState
            icon={<FileText className="w-4 h-4" />}
            title="No documents generated yet"
            description="Documents appear here once the agent produces them."
            steps={[
              { title: "Add companies and templates", body: "Both are needed before anything can be generated." },
              { title: "Train the agent", body: "Training teaches it which template answers which request." },
              { title: "Ask in chat", body: 'For example: "Create an AGM minute for City Holdings".' },
            ]}
          />
        ) : (
          <>
            <StatRow>
              <StatTile label="Documents" value={stats.total} />
              <StatTile label="Last 7 days" value={stats.last7} />
              <StatTile label="Companies covered" value={stats.companies} />
              <StatTile label="Templates used" value={stats.templates} />
            </StatRow>

            <DataTable
              rows={filtered}
              columns={columns}
              rowKey={(d, i) => d.id || `${d.file_name}-${i}`}
              onRowClick={setPreviewDoc}
              caption="Generated documents"
              empty={
                <div className="py-2">
                  <p className="text-[length:var(--text-sm)] text-[var(--text)]">
                    No documents match the current filters.
                  </p>
                  <Button size="sm" className="mt-3" onClick={clearFilters}>
                    Clear filters
                  </Button>
                </div>
              }
            />
          </>
        )}
      </PageBody>
    </Page>
  )
}
