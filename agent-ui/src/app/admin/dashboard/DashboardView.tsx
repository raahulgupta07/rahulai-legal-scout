"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Building,
  FilePlus,
  FileText,
  FolderOpen,
  PlusCircle,
  RefreshCw,
  UploadCloud,
  Wifi,
  WifiOff,
} from "lucide-react"
import Link from "next/link"
import apiClient, { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  LoadingScreen,
  Notice,
  Page,
  PageBody,
  PageHeader,
  StatRow,
  StatTile,
  dateSort,
  ensureOk,
  focusRing,
  formatDateTime,
} from "@/components/ui/kit"

interface Document {
  id: string
  template_name: string
  company_name: string
  file_name: string
  download_url: string
  created_at: string
  user_name?: string
  created_by_email?: string
}

const DAY = 24 * 60 * 60 * 1000

/** Documents per day for the last 14 days, oldest first. */
function dailyCounts(documents: Document[]) {
  const now = new Date()
  const days: { label: string; iso: string; count: number }[] = []
  for (let i = 13; i >= 0; i--) {
    const date = new Date(now.getTime() - i * DAY)
    const iso = date.toISOString().split("T")[0]
    days.push({
      iso,
      label: date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      count: documents.filter((d) => d.created_at?.startsWith(iso)).length,
    })
  }
  return days
}

function topBy(documents: Document[], key: (d: Document) => string) {
  const counts: Record<string, number> = {}
  documents.forEach((d) => {
    const k = key(d) || "Unknown"
    counts[k] = (counts[k] || 0) + 1
  })
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

export default function DashboardView() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [companies, setCompanies] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [isOnline, setIsOnline] = useState(true)
  const [lastSync, setLastSync] = useState<Date | null>(null)

  useEffect(() => {
    fetchData()
  }, [])

  useEffect(() => {
    setIsOnline(navigator.onLine)
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])

  const fetchData = async () => {
    setLoadError("")
    try {
      const res = await authFetch(apiClient.getDashboardData())
      await ensureOk(res, "Failed to load dashboard")
      const data = await res.json()
      setCompanies(data.companies || [])
      setTemplates(data.templates || [])
      setDocuments(data.documents || [])
      setLastSync(new Date())
    } catch (e: any) {
      console.error("Dashboard load error:", e)
      setLoadError(e?.message || "Failed to load dashboard")
    } finally {
      setLoading(false)
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchData()
    setRefreshing(false)
    toast.success("Dashboard refreshed")
  }

  const days = useMemo(() => dailyCounts(documents), [documents])
  const maxCount = Math.max(...days.map((d) => d.count), 1)

  const stats = useMemo(() => {
    const now = Date.now()
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
    const week = documents.filter((d) => d.created_at && now - new Date(d.created_at).getTime() < 7 * DAY).length
    const month = documents.filter((d) => d.created_at && new Date(d.created_at).getTime() >= monthStart).length
    return { week, month, perDay: (week / 7).toFixed(1) }
  }, [documents])

  const topTemplate = useMemo(() => topBy(documents, (d) => d.template_name)[0], [documents])
  const topCompany = useMemo(
    () => topBy(documents, (d) => d.company_name?.split("\n")[0])[0],
    [documents]
  )

  const recent = useMemo(
    () =>
      [...documents]
        .sort((a, b) => (dateSort(b.created_at) ?? 0) - (dateSort(a.created_at) ?? 0))
        .slice(0, 8),
    [documents]
  )

  if (loading) return <LoadingScreen label="Loading dashboard" />

  const setupIncomplete = templates.length === 0 || companies.length === 0

  const quickAction = (href: string, icon: React.ReactNode, title: string, body: string) => (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 px-3.5 py-3 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-sm)]",
        "hover:border-[var(--border-strong)] transition-colors min-w-0",
        focusRing
      )}
    >
      <span className="w-8 h-8 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] rounded-[var(--radius-sm)]">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[length:var(--text-sm)] font-medium text-[var(--text)]">{title}</span>
        <span className="block text-[length:var(--text-2xs)] text-[var(--text-muted)] truncate">{body}</span>
      </span>
    </Link>
  )

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        meta={
          isOnline ? undefined : (
            <Badge tone="danger" dot>
              Offline
            </Badge>
          )
        }
        description="Activity across templates, companies and generated documents."
        actions={
          <>
            <span className="hidden sm:flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--text-muted)]">
              {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              {lastSync ? `Synced ${lastSync.toLocaleTimeString()}` : "Never synced"}
            </span>
            <Button onClick={handleRefresh} loading={refreshing} icon={<RefreshCw className="w-4 h-4" />}>
              Refresh
            </Button>
          </>
        }
      />

      <PageBody className="space-y-4">
        {loadError && <Notice tone="danger" title="Could not load the dashboard">{loadError}</Notice>}

        {setupIncomplete && (
          <Notice tone="warn" title="Setup is incomplete">
            {templates.length === 0 && companies.length === 0
              ? "No templates and no companies yet — the agent cannot generate anything."
              : templates.length === 0
                ? "No templates yet. Upload and train at least one before generating documents."
                : "No companies yet. Add one so templates have data to fill from."}
          </Notice>
        )}

        <StatRow>
          <StatTile label="Documents" value={documents.length} icon={<FileText className="w-3.5 h-3.5" />} />
          <StatTile
            label="Templates"
            value={templates.length}
            tone={templates.length === 0 ? "warn" : undefined}
            icon={<FolderOpen className="w-3.5 h-3.5" />}
          />
          <StatTile
            label="Companies"
            value={companies.length}
            tone={companies.length === 0 ? "warn" : undefined}
            icon={<Building className="w-3.5 h-3.5" />}
          />
          <StatTile label="This week" value={stats.week} hint={`${stats.perDay} per day · ${stats.month} this month`} />
        </StatRow>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {quickAction("/", <FilePlus className="w-4 h-4" />, "Generate a document", "Ask the agent in chat")}
          {quickAction("/admin/templates", <UploadCloud className="w-4 h-4" />, "Upload a template", "Add a Word template")}
          {quickAction("/admin/companies", <PlusCircle className="w-4 h-4" />, "Add a company", "From a DICA PDF or by hand")}
        </div>

        <Card
          title="Documents generated"
          meta={<Badge tone="neutral">Last 14 days</Badge>}
          actions={
            <span className="text-[length:var(--text-2xs)] text-[var(--text-muted)] tabular-nums">
              peak {maxCount}/day
            </span>
          }
        >
          {documents.length === 0 ? (
            <p className="py-6 text-center text-[length:var(--text-sm)] text-[var(--text-muted)]">
              Nothing generated yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex items-end gap-1.5 h-32 min-w-[28rem]">
                {days.map((day) => (
                  <div key={day.iso} className="flex-1 flex flex-col items-center justify-end h-full gap-1 min-w-0">
                    <span className="text-[length:var(--text-2xs)] tabular-nums text-[var(--text-muted)] h-3">
                      {day.count > 0 ? day.count : ""}
                    </span>
                    <div
                      title={`${day.label}: ${day.count} document${day.count === 1 ? "" : "s"}`}
                      className="w-full transition-colors"
                      style={{
                        height: `${Math.max((day.count / maxCount) * 100, 2)}%`,
                        minHeight: day.count > 0 ? 6 : 2,
                        background: day.count > 0 ? "var(--brand)" : "var(--border)",
                      }}
                    />
                    <span className="text-[length:var(--text-2xs)] text-[var(--text-muted)] whitespace-nowrap">
                      {day.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Card title="Most used template">
            {topTemplate ? (
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2.5 min-w-0">
                  <span className="w-8 h-8 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-sm)]">
                    <FileText className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  </span>
                  <span className="text-[length:var(--text-sm)] font-medium text-[var(--text)] truncate">
                    {topTemplate[0]}
                  </span>
                </span>
                <Badge tone="neutral">{topTemplate[1]} uses</Badge>
              </div>
            ) : (
              <p className="text-[length:var(--text-sm)] text-[var(--text-muted)]">No data yet.</p>
            )}
          </Card>

          <Card title="Most active company">
            {topCompany ? (
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2.5 min-w-0">
                  <span className="w-8 h-8 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-sm)]">
                    <Building className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  </span>
                  <span className="text-[length:var(--text-sm)] font-medium text-[var(--text)] truncate">
                    {topCompany[0]}
                  </span>
                </span>
                <Badge tone="neutral">{topCompany[1]} documents</Badge>
              </div>
            ) : (
              <p className="text-[length:var(--text-sm)] text-[var(--text-muted)]">No data yet.</p>
            )}
          </Card>
        </div>

        <Card
          title="Recent documents"
          meta={<Badge tone="neutral">{recent.length}</Badge>}
          actions={
            <Link href="/admin/documents">
              <Button size="sm" variant="ghost">
                View all
              </Button>
            </Link>
          }
          padded={false}
        >
          {documents.length === 0 ? (
            <EmptyState
              icon={<FileText className="w-4 h-4" />}
              title="No documents yet"
              description="Once the agent generates a document it will appear here."
            />
          ) : (
            <DataTable
              className="border-0 rounded-none"
              rows={recent}
              rowKey={(d, i) => d.id || `${d.file_name}-${i}`}
              columns={[
                {
                  key: "file_name",
                  header: "Document",
                  render: (d) => (
                    <span className="block font-medium text-[var(--text)] truncate max-w-[280px]">{d.file_name}</span>
                  ),
                },
                {
                  key: "company_name",
                  header: "Company",
                  hideBelow: "sm",
                  render: (d) => (
                    <span className="block truncate max-w-[160px]">{d.company_name?.split("\n")[0] || "—"}</span>
                  ),
                },
                {
                  key: "template_name",
                  header: "Template",
                  hideBelow: "md",
                  render: (d) => <span className="block truncate max-w-[160px]">{d.template_name || "—"}</span>,
                },
                {
                  key: "created_at",
                  header: "Created",
                  align: "right",
                  render: (d) => (
                    <span className="tabular-nums whitespace-nowrap">{formatDateTime(d.created_at)}</span>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </PageBody>
    </Page>
  )
}
