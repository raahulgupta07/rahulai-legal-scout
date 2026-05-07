"use client"

import { useEffect, useState, useMemo } from "react"
import { Download, Eye, Loader2, Calendar, X, Search, CheckCircle, FileText, Trash2, ArrowUpDown, ArrowLeft } from "lucide-react"
import apiClient, { authFetch } from "@/lib/api-client"
import DocViewer from "@/components/ui/DocViewer"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || ''

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

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [startDate, setStartDate] = useState<string>("")
  const [endDate, setEndDate] = useState<string>("")
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null)
  const [previewDetail, setPreviewDetail] = useState<any>(null)
  const [sortField, setSortField] = useState<string>("created_at")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

  useEffect(() => {
    if (!previewDoc) { setPreviewDetail(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await authFetch(apiClient.documentDetail(previewDoc.id))
        const json = await res.json()
        if (!cancelled && json.success) setPreviewDetail(json.data)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [previewDoc])

  useEffect(() => {
    fetchDocuments()
  }, [])

  const fetchDocuments = async () => {
    try {
      const res = await authFetch(apiClient.getDashboardData())
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json()
      setDocuments(data.documents || [])
    } catch (e) {
      console.error("Fetch error:", e)
    } finally {
      setLoading(false)
    }
  }

  // Filter documents by date range and search query
  const filteredDocuments = useMemo(() => {
    let filtered = documents

    // Date filter
    if (startDate || endDate) {
      filtered = filtered.filter(doc => {
        if (!doc.created_at) return true

        const docDate = new Date(doc.created_at)
        const start = startDate ? new Date(startDate) : null
        const end = endDate ? new Date(endDate) : null

        // Set end date to end of day for inclusive filtering
        if (end) {
          end.setHours(23, 59, 59, 999)
        }

        if (start && end) {
          return docDate >= start && docDate <= end
        } else if (start) {
          return docDate >= start
        } else if (end) {
          return docDate <= end
        }

        return true
      })
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      filtered = filtered.filter(doc =>
        (doc.file_name && doc.file_name.toLowerCase().includes(q)) ||
        (doc.company_name && doc.company_name.toLowerCase().includes(q)) ||
        (doc.template_name && doc.template_name.toLowerCase().includes(q))
      )
    }

    // Sort
    filtered.sort((a, b) => {
      let aVal = (a as any)[sortField] || ""
      let bVal = (b as any)[sortField] || ""
      if (sortField === "created_at") {
        aVal = aVal ? new Date(aVal).getTime() : 0
        bVal = bVal ? new Date(bVal).getTime() : 0
      } else {
        aVal = String(aVal).toLowerCase()
        bVal = String(bVal).toLowerCase()
      }
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1
      return 0
    })

    return filtered
  }, [documents, startDate, endDate, searchQuery, sortField, sortDir])

  const clearFilters = () => {
    setStartDate("")
    setEndDate("")
    setSearchQuery("")
  }

  const handleDelete = async (doc: Document) => {
    if (!confirm(`Delete "${doc.file_name}"?`)) return
    try {
      const docRef = doc.id || encodeURIComponent(doc.file_name)
      const res = await authFetch(`${API_BASE_URL}/api/dashboard/document/${docRef}`, { method: "DELETE" })
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json()
      if (data.success) {
        setDocuments(prev => prev.filter(d => d.file_name !== doc.file_name))
        if (previewDoc?.file_name === doc.file_name) setPreviewDoc(null)
      } else {
        alert(data.error || "Failed to delete")
      }
    } catch (e) {
      console.error("Delete error:", e)
      alert("Failed to delete document")
    }
  }

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(prev => prev === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortDir("desc")
    }
  }

  const hasActiveFilters = startDate || endDate || searchQuery.trim()

  const handleRowClick = (doc: Document) => {
    setPreviewDoc(prev => prev?.file_name === doc.file_name ? null : doc)
  }

  const getPreviewUrl = (fileName: string) => {
    return `${API_BASE_URL}/api/documents/preview-pdf/${encodeURIComponent(fileName)}`
  }

  const getDownloadUrl = (doc: Document) => {
    return doc.download_url || `${API_BASE_URL}/documents/legal/output/${encodeURIComponent(doc.file_name)}`
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  // ── Split-view preview screen ──
  if (previewDoc) {
    const tok = typeof window !== 'undefined' ? (localStorage.getItem('ls_token') || '') : ''
    const customData = previewDetail?.custom_data || {}
    const validation = previewDetail?.validation_result || {}
    const placeholders: Array<[string, any]> = Object.entries(customData)
    return (
      <div className="flex flex-col h-full m-1.5 rounded-xl bg-background overflow-hidden">
        {/* Top bar — back + filename + download */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/10 bg-card">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={() => setPreviewDoc(null)} className="p-1.5 rounded-lg hover:bg-accent text-muted hover:text-primary shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <FileText className="w-4 h-4 text-brand shrink-0" />
            <span className="text-sm font-semibold text-primary truncate">{previewDoc.file_name}</span>
          </div>
          <a href={getDownloadUrl(previewDoc)} download
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-black text-white rounded-lg hover:bg-black/80 shrink-0">
            <Download className="w-3 h-3" /> Download
          </a>
        </div>
        {/* Split: PDF left, info right */}
        <div className="flex flex-1 overflow-hidden">
          <div className="w-1/2 flex flex-col border-r border-primary/10">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-primary/10 bg-accent/30 shrink-0">
              <Eye className="w-4 h-4 text-brand" />
              <span className="text-xs font-semibold text-primary">Document Preview</span>
            </div>
            <DocViewer
              url={`${getPreviewUrl(previewDoc.file_name)}?token=${tok}`}
              forceFormat="pdf"
              className="flex-1 w-full bg-white"
            />
          </div>
          <div className="w-1/2 flex flex-col">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-primary/10 bg-accent/30 shrink-0">
              <FileText className="w-4 h-4 text-brand" />
              <span className="text-xs font-semibold text-primary">Placeholders & Metadata</span>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-accent/30 rounded-lg">
                  <div className="text-xs text-muted">Template</div>
                  <div className="font-medium text-primary truncate">{previewDoc.template_name}</div>
                </div>
                <div className="p-3 bg-accent/30 rounded-lg">
                  <div className="text-xs text-muted">Company</div>
                  <div className="font-medium text-primary truncate">{previewDoc.company_name}</div>
                </div>
                <div className="p-3 bg-accent/30 rounded-lg">
                  <div className="text-xs text-muted">Created</div>
                  <div className="font-medium text-primary">{new Date(previewDoc.created_at).toLocaleString()}</div>
                </div>
                <div className="p-3 bg-accent/30 rounded-lg">
                  <div className="text-xs text-muted">Generated by</div>
                  <div className="font-medium text-primary truncate">{previewDoc.user_name || previewDoc.created_by_email || '—'}</div>
                </div>
              </div>

              {validation && (validation.total_placeholders !== undefined) && (
                <div className="p-3 border border-primary/10 rounded-lg bg-card">
                  <div className="text-xs font-semibold text-muted mb-2">Validation</div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div><div className="text-lg font-bold text-primary">{validation.total_placeholders ?? '—'}</div><div className="text-[10px] text-muted">Total</div></div>
                    <div><div className="text-lg font-bold text-green-600">{validation.filled_from_data ?? '—'}</div><div className="text-[10px] text-muted">Filled</div></div>
                    <div><div className="text-lg font-bold text-amber-600">{validation.unfilled ?? '—'}</div><div className="text-[10px] text-muted">Unfilled</div></div>
                    <div><div className="text-xs font-bold text-primary">{validation.validation_status ?? '—'}</div><div className="text-[10px] text-muted">Status</div></div>
                  </div>
                </div>
              )}

              <div>
                <div className="text-xs font-semibold text-muted mb-2 flex items-center gap-2">
                  <CheckCircle className="w-3 h-3" /> Placeholder Values ({placeholders.length})
                </div>
                {placeholders.length === 0 ? (
                  <div className="text-xs text-muted italic p-3 bg-accent/20 rounded-lg">No custom_data recorded for this document.</div>
                ) : (
                  <div className="border border-primary/10 rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-accent/40 text-muted">
                        <tr><th className="text-left px-3 py-2 font-semibold">Field</th><th className="text-left px-3 py-2 font-semibold">Value</th></tr>
                      </thead>
                      <tbody>
                        {placeholders.map(([k, v]) => {
                          const isTBD = String(v).trim().toUpperCase() === "TBD" || v === "" || v == null
                          return (
                            <tr key={k} className="border-t border-primary/5 hover:bg-accent/20">
                              <td className="px-3 py-2 font-mono text-primary/80 align-top">{`{{${k}}}`}</td>
                              <td className={`px-3 py-2 break-words ${isTBD ? "text-amber-600" : "text-primary"}`}>{String(v ?? "—")}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full m-1.5 rounded-xl bg-background">
      {/* Header */}
      <div className="flex flex-col gap-3 p-4 border-b border-gray-400 dark:border-primary/10">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">
            Generated Documents ({filteredDocuments.length}
            {hasActiveFilters && ` of ${documents.length}`})
          </h1>
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            placeholder="Search by document name, company, or template..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-card border border-primary/10 rounded-lg text-primary placeholder:text-muted focus:outline-none focus:border-primary/40"
          />
        </div>

        {/* Date Filter */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted" />
            <span className="text-sm text-muted">Filter by date:</span>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-muted">From:</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-2 py-1 text-sm bg-card border border-primary/10 rounded-lg text-white focus:outline-none focus:border-primary/40"
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-muted">To:</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-2 py-1 text-sm bg-card border border-primary/10 rounded-lg text-white focus:outline-none focus:border-primary/40"
            />
          </div>

          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-3 py-1 text-xs font-medium bg-accent hover:bg-accent/80 text-white rounded-lg transition-colors"
            >
              <X className="w-3 h-3" />
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {/* Documents Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="border border-primary/10 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-card">
                <tr className="text-left text-xs text-muted border-b border-primary/10">
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Status</th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap cursor-pointer hover:text-primary select-none" onClick={() => toggleSort("created_at")}>
                    Created {sortField === "created_at" && <ArrowUpDown className="w-3 h-3 inline ml-1" />}
                  </th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap cursor-pointer hover:text-primary select-none" onClick={() => toggleSort("file_name")}>
                    Document Name {sortField === "file_name" && <ArrowUpDown className="w-3 h-3 inline ml-1" />}
                  </th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap cursor-pointer hover:text-primary select-none" onClick={() => toggleSort("company_name")}>
                    Company {sortField === "company_name" && <ArrowUpDown className="w-3 h-3 inline ml-1" />}
                  </th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap cursor-pointer hover:text-primary select-none" onClick={() => toggleSort("template_name")}>
                    Template {sortField === "template_name" && <ArrowUpDown className="w-3 h-3 inline ml-1" />}
                  </th>
                  <th className="px-4 py-3 font-medium whitespace-nowrap">Created By</th>
                  <th className="px-4 py-3 font-medium text-center whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary/15">
                {filteredDocuments.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted text-sm">
                      {hasActiveFilters ? 'No documents found for the current filters' : 'No documents generated yet'}
                    </td>
                  </tr>
                ) : (
                  filteredDocuments.map((d: Document, i: number) => (
                    <tr
                      key={d.id || i}
                      className="hover:bg-accent/50 cursor-pointer transition-colors"
                      onClick={() => handleRowClick(d)}
                    >
                      {/* Status */}
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-green-500/10 text-green-700">
                          <CheckCircle className="w-3 h-3" />
                          Success
                        </span>
                      </td>
                      {/* Created Date */}
                      <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">
                        {d.created_at ? new Date(d.created_at).toLocaleString('en-US', {
                          month: 'short', day: 'numeric', year: 'numeric',
                          hour: '2-digit', minute: '2-digit', hour12: true
                        }) : '-'}
                      </td>
                      {/* Document Name with View + Download icons */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <button onClick={() => handleRowClick(d)} className="p-1 text-muted hover:text-brand hover:bg-brand/10 rounded" title="Preview">
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <a href={getDownloadUrl(d)} download className="p-1 text-muted hover:text-primary hover:bg-accent rounded" title="Download">
                              <Download className="w-3.5 h-3.5" />
                            </a>
                          </div>
                          <p className="text-sm font-medium text-primary truncate max-w-[350px]">{d.file_name}</p>
                        </div>
                      </td>
                      {/* Company */}
                      <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">
                        {d.company_name ? d.company_name.split('\n')[0] : '-'}
                      </td>
                      {/* Template */}
                      <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">{d.template_name || '-'}</td>
                      {/* Created By */}
                      <td className="px-4 py-3 text-xs text-gray-500">{d.created_by_email || '—'}</td>
                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleDelete(d)}
                            className="p-1.5 text-muted hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  )
}
