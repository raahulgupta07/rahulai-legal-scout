"use client"

import { useEffect, useState } from "react"
import { Brain, ChevronDown, Database, FileCheck, FileText, RefreshCw, Table as TableIcon } from "lucide-react"
import { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Badge,
  Button,
  Card,
  DataTable,
  DetailList,
  LoadingScreen,
  Notice,
  Page,
  PageBody,
  PageHeader,
  StatRow,
  StatTile,
  ensureOk,
  focusRing,
  formatNumber,
} from "@/components/ui/kit"

interface TableInfo {
  name: string
  row_count: number
  /** Plain-English purpose, so the screen is readable without schema knowledge. */
  purpose: string
}

interface TrainingStats {
  total_templates: number
  trained_templates: number
  total_fields: number
  last_trained: string | null
}

const TABLES: TableInfo[] = [
  { name: "templates", row_count: 0, purpose: "Template metadata — 37 columns written by training" },
  { name: "knowledge_sources", row_count: 0, purpose: "Files that have been synced into the knowledge base" },
  { name: "knowledge_vec", row_count: 0, purpose: "Vector embeddings backing semantic search" },
  { name: "knowledge_lookup", row_count: 0, purpose: "Fast key-value lookups the agent reads first" },
  { name: "knowledge_raw", row_count: 0, purpose: "Raw ingested data before processing" },
  { name: "documents", row_count: 0, purpose: "Every generated document and how it was filled" },
]

const tableIcon = (name: string) => {
  if (name === "templates") return <FileText className="w-3.5 h-3.5" />
  if (name === "documents") return <FileCheck className="w-3.5 h-3.5" />
  if (name.includes("knowledge")) return <Brain className="w-3.5 h-3.5" />
  return <TableIcon className="w-3.5 h-3.5" />
}

export default function KnowledgePage() {
  const [tables, setTables] = useState<TableInfo[]>(TABLES)
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [tableData, setTableData] = useState<any[]>([])
  const [tableLoading, setTableLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [stats, setStats] = useState<TrainingStats | null>(null)
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || ""

  useEffect(() => {
    refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchStats = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/dashboard/templates`)
      await ensureOk(res, "Failed to load template stats")
      const data = await res.json()
      const templates = data.templates || []
      setStats({
        total_templates: templates.length,
        trained_templates: templates.filter((t: any) => t.ai_trained).length,
        total_fields: templates.reduce((sum: number, t: any) => sum + (t.total_fields || 0), 0),
        last_trained: null,
      })
    } catch (e: any) {
      console.error("Failed to fetch stats:", e)
      setLoadError(e?.message || "Failed to load training stats")
    }
  }

  const fetchTables = async () => {
    // Counts are fetched per table; one failure must not blank the others.
    const results = await Promise.all(
      TABLES.map(async (table) => {
        try {
          const res = await authFetch(`${API_BASE}/api/knowledge/table/${table.name}`)
          await ensureOk(res, `Failed to read ${table.name}`)
          const data = await res.json()
          return { ...table, row_count: data.count ?? 0 }
        } catch (e) {
          console.error(`Table count error (${table.name}):`, e)
          return { ...table, row_count: 0 }
        }
      })
    )
    setTables(results)
  }

  const refreshAll = async () => {
    setRefreshing(true)
    setLoadError("")
    await Promise.all([fetchTables(), fetchStats()])
    setLoading(false)
    setRefreshing(false)
  }

  const toggleTable = async (name: string) => {
    if (selectedTable === name) {
      setSelectedTable(null)
      setTableData([])
      return
    }
    setSelectedTable(name)
    setTableData([])
    setTableLoading(true)
    try {
      const res = await authFetch(`${API_BASE}/api/knowledge/table/${name}`)
      await ensureOk(res, `Failed to load ${name}`)
      const data = await res.json()
      setTableData(data.data || [])
    } catch (e: any) {
      console.error("Failed to fetch data:", e)
      toast.error(e?.message || `Failed to load ${name}`)
    } finally {
      setTableLoading(false)
    }
  }

  if (loading) return <LoadingScreen label="Loading knowledge base" />

  const totalRows = tables.reduce((sum, t) => sum + t.row_count, 0)
  const emptyTables = tables.filter((t) => t.row_count === 0).length

  return (
    <Page>
      <PageHeader
        title="Knowledge base"
        meta={<Badge tone="neutral">{formatNumber(totalRows)} rows</Badge>}
        description="What the agent actually knows. Training writes into these tables; the agent reads from them at answer time."
        actions={
          <Button onClick={refreshAll} loading={refreshing} icon={<RefreshCw className="w-4 h-4" />}>
            Refresh
          </Button>
        }
      />

      <PageBody className="space-y-4">
        {loadError && <Notice tone="warn" title="Some figures may be incomplete">{loadError}</Notice>}

        <StatRow>
          <StatTile label="Templates" value={stats?.total_templates ?? "—"} />
          <StatTile
            label="Trained"
            value={stats?.trained_templates ?? "—"}
            tone={
              stats && stats.total_templates > 0 && stats.trained_templates < stats.total_templates ? "warn" : undefined
            }
            hint={
              stats && stats.total_templates > 0
                ? `${stats.total_templates - stats.trained_templates} untrained`
                : undefined
            }
          />
          <StatTile label="Placeholders indexed" value={formatNumber(stats?.total_fields ?? null)} />
          <StatTile
            label="Empty tables"
            value={emptyTables}
            tone={emptyTables > 0 ? "warn" : undefined}
            hint={emptyTables > 0 ? "Run training to populate" : "All tables have data"}
          />
        </StatRow>

        <Card title="Tables" meta={<Badge tone="neutral">{tables.length}</Badge>} padded={false}>
          <ul>
            {tables.map((table) => {
              const open = selectedTable === table.name
              return (
                <li key={table.name} className="border-b border-[var(--border)] last:border-b-0">
                  <button
                    onClick={() => toggleTable(table.name)}
                    aria-expanded={open}
                    className={cn(
                      "flex items-center justify-between gap-3 w-full px-4 py-2.5 text-left transition-colors",
                      "hover:bg-[var(--bg-secondary)]",
                      focusRing
                    )}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <ChevronDown
                        className={cn(
                          "w-3.5 h-3.5 shrink-0 text-[var(--text-muted)] transition-transform",
                          !open && "-rotate-90"
                        )}
                      />
                      <span className="text-[var(--text-muted)] shrink-0">{tableIcon(table.name)}</span>
                      <span className="min-w-0">
                        <span className="block font-mono text-[length:var(--text-sm)] text-[var(--text)]">
                          {table.name}
                        </span>
                        <span className="block text-[length:var(--text-2xs)] text-[var(--text-muted)] truncate">
                          {table.purpose}
                        </span>
                      </span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-[length:var(--text-sm)] tabular-nums text-[var(--text-secondary)]">
                        {formatNumber(table.row_count)}
                      </span>
                      {table.row_count === 0 ? (
                        <Badge tone="warn">Empty</Badge>
                      ) : (
                        <Badge tone="ok" dot>
                          Populated
                        </Badge>
                      )}
                    </span>
                  </button>

                  {open && (
                    <div className="px-4 pb-4 bg-[var(--bg-secondary)]">
                      {tableLoading ? (
                        <p className="py-6 text-center text-[length:var(--text-xs)] text-[var(--text-muted)]">
                          Loading rows…
                        </p>
                      ) : tableData.length === 0 ? (
                        <p className="py-6 text-center text-[length:var(--text-xs)] text-[var(--text-muted)]">
                          No rows in this table.
                        </p>
                      ) : (
                        <>
                          <DataTable
                            maxHeight="20rem"
                            rows={tableData.slice(0, 25)}
                            rowKey={(_r, i) => i}
                            columns={Object.keys(tableData[0] || {})
                              .filter((k) => k !== "id")
                              .slice(0, 6)
                              .map((key) => ({
                                key,
                                header: key,
                                render: (row: any) => {
                                  const v = row[key]
                                  const text = typeof v === "object" ? JSON.stringify(v) : String(v ?? "")
                                  return (
                                    <span className="block max-w-[220px] truncate" title={text}>
                                      {text || "—"}
                                    </span>
                                  )
                                },
                              }))}
                          />
                          <p className="mt-2 text-[length:var(--text-2xs)] text-[var(--text-muted)]">
                            Showing the first {Math.min(25, tableData.length)} of {formatNumber(table.row_count)} rows,
                            first 6 columns.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title="What training writes">
            <ul className="space-y-1 text-[length:var(--text-xs)] text-[var(--text-secondary)]">
              {[
                ["purpose", "What the document is for"],
                ["when_to_use", "The situation that calls for it"],
                ["how_to_use", "Step-by-step guidance"],
                ["prerequisites", "Documents needed first"],
                ["field_mapping", "Placeholder → database column"],
                ["training_confidence", "Share of the 15 steps that passed"],
              ].map(([field, desc]) => (
                <li key={field} className="flex gap-2">
                  <span className="font-mono text-[var(--text)] shrink-0">{field}</span>
                  <span className="text-[var(--text-muted)]">{desc}</span>
                </li>
              ))}
              <li className="text-[var(--text-muted)]">…and twelve more columns on the templates table.</li>
            </ul>
          </Card>

          <Card title="Where data lives">
            <DetailList
              columns={1}
              items={[
                ["PostgreSQL (scout-db)", "Every table listed above, plus pgvector embeddings"],
                ["Templates", <span key="t" className="font-mono">/documents/legal/templates/</span>],
                ["Generated documents", <span key="o" className="font-mono">/documents/legal/output/</span>],
              ]}
            />
          </Card>
        </div>
      </PageBody>
    </Page>
  )
}
