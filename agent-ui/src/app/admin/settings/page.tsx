"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Brain,
  Cloud,
  Database,
  KeyRound,
  Download,
  Eye,
  EyeOff,
  HardDrive,
  Mail,
  Save,
  Send,
  Settings as SettingsIcon,
  Shield,
  Trash2,
  Upload,
  User,
} from "lucide-react"
import { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import UsersView from "../users/UsersView"
import AuthPanel from "./AuthPanel"
import KnowledgeView from "../knowledge/KnowledgeView"
import { RANK, getRole, useUserRole } from "../roleClient"
import {
  Badge,
  Button,
  Card,
  DataTable,
  IconButton,
  Input,
  LoadingScreen,
  Modal,
  Notice,
  Page,
  PageBody,
  PageHeader,
  StatRow,
  StatTile,
  TextField,
  Toggle,
  Toolbar,
  type Tone,
  assertSuccess,
  dateSort,
  ensureOk,
  errorMessage,
  focusRing,
  formatDateTime,
} from "@/components/ui/kit"

const API = process.env.NEXT_PUBLIC_API_URL || ""

const SMTP_PRESETS = [
  {
    name: "Gmail",
    host: "smtp.gmail.com",
    port: "587",
    notes: "Use an App Password, not your account password. Enable 2FA first, then Google Account → Security → App Passwords.",
  },
  {
    name: "Outlook / Microsoft 365",
    host: "smtp.office365.com",
    port: "587",
    notes: "Use your Microsoft 365 email address and password.",
  },
  {
    name: "Yahoo",
    host: "smtp.mail.yahoo.com",
    port: "587",
    notes: "Generate an App Password in Yahoo Account Settings.",
  },
  { name: "Custom SMTP", host: "", port: "587", notes: "Enter your own SMTP server details." },
]

const MODEL_ROWS = [
  { key: "chat", label: "Chat agent", desc: "Answers in the chat interface" },
  { key: "training", label: "Training & analysis", desc: "Reads and analyses templates" },
  { key: "classification", label: "Field classification", desc: "Splits placeholders into auto-fill and user input" },
  { key: "embedding", label: "Embeddings", desc: "Powers semantic search over the knowledge base" },
]

const TIMEZONES = [
  { group: "Asia", zones: [
    ["Asia/Yangon", "Asia/Yangon (Myanmar)"],
    ["Asia/Singapore", "Asia/Singapore"],
    ["Asia/Kuala_Lumpur", "Asia/Kuala_Lumpur (Malaysia)"],
    ["Asia/Bangkok", "Asia/Bangkok (Thailand)"],
    ["Asia/Ho_Chi_Minh", "Asia/Ho_Chi_Minh (Vietnam)"],
    ["Asia/Jakarta", "Asia/Jakarta (Indonesia)"],
    ["Asia/Manila", "Asia/Manila (Philippines)"],
    ["Asia/Kolkata", "Asia/Kolkata (India)"],
    ["Asia/Shanghai", "Asia/Shanghai (China)"],
    ["Asia/Tokyo", "Asia/Tokyo (Japan)"],
    ["Asia/Seoul", "Asia/Seoul (Korea)"],
    ["Asia/Hong_Kong", "Asia/Hong_Kong"],
    ["Asia/Taipei", "Asia/Taipei (Taiwan)"],
    ["Asia/Dubai", "Asia/Dubai (UAE)"],
  ] },
  { group: "Other", zones: [
    ["UTC", "UTC"],
    ["US/Eastern", "US/Eastern"],
    ["US/Pacific", "US/Pacific"],
    ["Europe/London", "Europe/London"],
    ["Australia/Sydney", "Australia/Sydney"],
  ] },
]

type Tab = "models" | "email" | "system" | "activity" | "users" | "auth" | "knowledge"

/**
 * Tabs with the minimum role that may see each. The four configuration tabs
 * plus Users are admin-only; Knowledge is editor-visible (it absorbed the old
 * editor-accessible /admin/knowledge page). Non-admins only ever see Knowledge.
 */
const SETTINGS_TABS: { id: Tab; label: string; icon: React.ReactNode; minRole: string }[] = [
  { id: "models", label: "AI models", icon: <Brain className="w-3.5 h-3.5" />, minRole: "admin" },
  { id: "email", label: "Email", icon: <Mail className="w-3.5 h-3.5" />, minRole: "admin" },
  { id: "system", label: "System", icon: <HardDrive className="w-3.5 h-3.5" />, minRole: "admin" },
  { id: "activity", label: "Activity", icon: <BarChart3 className="w-3.5 h-3.5" />, minRole: "admin" },
  { id: "users", label: "Users", icon: <Shield className="w-3.5 h-3.5" />, minRole: "admin" },
  { id: "auth", label: "Authentication", icon: <KeyRound className="w-3.5 h-3.5" />, minRole: "admin" },
  { id: "knowledge", label: "Knowledge", icon: <Brain className="w-3.5 h-3.5" />, minRole: "editor" },
]

/** Each destructive reset, with the phrase that unlocks it. */
const RESETS: { id: string; endpoint: string; label: string; blurb: string; phrase: string }[] = [
  {
    id: "documents",
    endpoint: "reset/documents",
    label: "Delete all documents",
    blurb: "Removes every generated document. Templates and companies are untouched.",
    phrase: "DELETE DOCUMENTS",
  },
  {
    id: "companies",
    endpoint: "reset/companies",
    label: "Delete all companies",
    blurb: "Removes every company record. Documents already generated are kept.",
    phrase: "DELETE COMPANIES",
  },
  {
    id: "chat",
    endpoint: "reset/chat",
    label: "Reset chat & memory",
    blurb: "Clears chat sessions, agent memory and learnings. Registers are untouched.",
    phrase: "RESET CHAT",
  },
  {
    id: "all",
    endpoint: "reset/all",
    label: "Delete all data",
    blurb: "Companies, documents, knowledge base, chat and memory. Everything.",
    phrase: "DELETE EVERYTHING",
  },
]

function SettingsInner() {
  const router = useRouter()
  const params = useSearchParams()
  const role = useUserRole()
  const [loading, setLoading] = useState(true)
  const paramTab = params.get("tab") as Tab | null
  const [activeTab, setActiveTab] = useState<Tab>(
    paramTab && SETTINGS_TABS.some((t) => t.id === paramTab) ? paramTab : "models"
  )

  // Tabs the current role may see; a non-admin only ever sees Knowledge.
  const visibleTabs = SETTINGS_TABS.filter((t) => (RANK[role] ?? 0) >= RANK[t.minRole])
  // Clamp the active tab to something this role is allowed to render.
  const active: Tab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : visibleTabs[0]?.id ?? "knowledge"

  const select = (id: Tab) => {
    setActiveTab(id)
    router.replace(`/admin/settings/?tab=${id}`, { scroll: false })
  }

  // Email
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [smtpHost, setSmtpHost] = useState("")
  const [smtpPort, setSmtpPort] = useState("587")
  const [smtpUser, setSmtpUser] = useState("")
  const [smtpPass, setSmtpPass] = useState("")
  const [smtpFrom, setSmtpFrom] = useState("")
  const [testEmail, setTestEmail] = useState("")
  const [lastUpdated, setLastUpdated] = useState("")

  // Models
  const [models, setModels] = useState<Record<string, string>>({})
  const [modelsSaving, setModelsSaving] = useState(false)
  const [modelsEditing, setModelsEditing] = useState(false)
  const [apiKeyStatus, setApiKeyStatus] = useState<any>(null)
  const [testingModel, setTestingModel] = useState("")
  const [validatingAll, setValidatingAll] = useState(false)
  const [modelTests, setModelTests] = useState<Record<string, { model: string; ok: boolean; msg: string; time: string }>>({})

  // System
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthData, setHealthData] = useState<any>(null)
  const [dbStats, setDbStats] = useState<any>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreResult, setRestoreResult] = useState<any>(null)
  const [deleting, setDeleting] = useState("")
  const [resetTarget, setResetTarget] = useState<(typeof RESETS)[number] | null>(null)
  const [resetConfirm, setResetConfirm] = useState("")

  // S3
  const [s3, setS3] = useState({
    enabled: false, bucket: "", region: "ap-southeast-1", access_key: "", secret_key: "", endpoint_url: "",
  })
  const [s3Saving, setS3Saving] = useState(false)
  const [s3Testing, setS3Testing] = useState(false)
  const [s3Syncing, setS3Syncing] = useState(false)
  const [s3Status, setS3Status] = useState<{ ok: boolean; msg: string } | null>(null)

  // Timezone
  const [timezone, setTimezone] = useState("Asia/Yangon")
  const [tzDatetime, setTzDatetime] = useState("")
  const [tzSaving, setTzSaving] = useState(false)

  // Activity
  const [activityData, setActivityData] = useState<any>(null)
  const [activityLoading, setActivityLoading] = useState(false)

  useEffect(() => {
    // Only admins reach the configuration tabs; a non-admin lands on Knowledge,
    // so skip the admin-only loads (they would 403) and render immediately.
    if (getRole() === "admin") {
      loadSettings()
      loadModels()
      loadTimezone()
      loadS3()
    } else {
      setLoading(false)
    }
  }, [])

  const loadS3 = async () => {
    try {
      const res = await authFetch(`${API}/api/admin/s3`)
      await ensureOk(res, "Failed to load S3 settings")
      const data = await res.json()
      if (data.config) setS3((prev) => ({ ...prev, ...data.config }))
    } catch (e) {
      console.error("S3 settings load error:", e)
    }
  }

  const loadTimezone = async () => {
    try {
      const res = await authFetch(`${API}/api/admin/timezone`)
      await ensureOk(res, "Failed to load timezone")
      const data = await res.json()
      setTimezone(data.timezone)
      setTzDatetime(data.current_datetime)
    } catch (e) {
      console.error("Timezone load error:", e)
    }
  }

  const saveTimezone = async () => {
    setTzSaving(true)
    try {
      const res = await authFetch(`${API}/api/admin/timezone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone }),
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to save timezone"))
      await assertSuccess(res, "Invalid timezone")
      const data = await res.json()
      toast.success(`Timezone set to ${data.timezone}`)
      setTzDatetime(data.current_datetime)
    } catch (e: any) {
      toast.error(e?.message || "Failed to save timezone")
    } finally {
      setTzSaving(false)
    }
  }

  const loadModels = async () => {
    try {
      const res = await authFetch(`${API}/api/admin/models`)
      await ensureOk(res, "Failed to load models")
      setModels((await res.json()).models)

      const kRes = await authFetch(`${API}/api/admin/api-keys`)
      await ensureOk(kRes, "Failed to load API key status")
      setApiKeyStatus((await kRes.json()).keys)

      const tRes = await authFetch(`${API}/api/admin/model-tests`)
      await ensureOk(tRes, "Failed to load model tests")
      setModelTests((await tRes.json()).tests || {})
    } catch (e) {
      console.error("Models load error:", e)
    }
  }

  const testModel = async (key: string) => {
    if (!models[key]) return
    setTestingModel(key)
    try {
      const r = await authFetch(`${API}/api/admin/test-model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: models[key], purpose: key === "embedding" ? "embedding" : "chat" }),
      })
      const d = await r.json()
      setModelTests((p) => ({
        ...p,
        [key]: { model: models[key], ok: !!d.success, msg: d.message || d.error, time: new Date().toISOString() },
      }))
      return !!d.success
    } catch (e) {
      console.error("Model test error:", e)
      setModelTests((p) => ({
        ...p,
        [key]: { model: models[key], ok: false, msg: "Request failed", time: new Date().toISOString() },
      }))
      return false
    } finally {
      setTestingModel("")
    }
  }

  const validateAll = async () => {
    setValidatingAll(true)
    const keys = Object.keys(models).filter((k) => models[k])
    let passed = 0
    for (const k of keys) {
      if (await testModel(k)) passed++
    }
    setValidatingAll(false)
    toast[passed === keys.length ? "success" : "error"](`${passed}/${keys.length} models verified`)
  }

  const saveModels = async () => {
    setModelsSaving(true)
    try {
      const res = await authFetch(`${API}/api/admin/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models }),
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Save failed"))
      await assertSuccess(res, "Save failed")
      toast.success("Models saved")
      setModelsEditing(false)
    } catch (e: any) {
      toast.error(e?.message || "Failed to save models")
    } finally {
      setModelsSaving(false)
    }
  }

  const loadSettings = async () => {
    try {
      const res = await authFetch(`${API}/api/admin/settings`)
      await ensureOk(res, "Failed to load settings")
      const data = await res.json()
      const s = data.settings
      if (s) {
        setSmtpHost(s.smtp_host?.value || "")
        setSmtpPort(s.smtp_port?.value || "587")
        setSmtpUser(s.smtp_user?.value || "")
        setSmtpPass(s.smtp_pass?.value || "")
        setSmtpFrom(s.smtp_from?.value || "")
        if (s.smtp_host?.updated_at) setLastUpdated(new Date(s.smtp_host.updated_at).toLocaleString())
      }
    } catch (e) {
      console.error("Settings load error:", e)
    } finally {
      setLoading(false)
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    try {
      const res = await authFetch(`${API}/api/admin/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smtp_host: smtpHost, smtp_port: smtpPort, smtp_user: smtpUser,
          smtp_pass: smtpPass, smtp_from: smtpFrom,
        }),
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Save failed"))
      await assertSuccess(res, "Save failed")
      toast.success("Email settings saved")
      setLastUpdated(new Date().toLocaleString())
    } catch (e: any) {
      toast.error(e?.message || "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const sendTestEmail = async () => {
    if (!testEmail) {
      toast.error("Enter an address to send the test to")
      return
    }
    setTesting(true)
    try {
      const res = await authFetch(`${API}/api/admin/test-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_email: testEmail }),
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Test failed"))
      await assertSuccess(res, "Test failed")
      toast.success(`Test email sent to ${testEmail}`)
    } catch (e: any) {
      toast.error(e?.message || "Failed to send test email")
    } finally {
      setTesting(false)
    }
  }

  const handleBackup = async () => {
    try {
      const res = await authFetch(`${API}/api/admin/backup`)
      if (!res.ok) throw new Error(await errorMessage(res, "Backup failed"))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `legal_scout_backup_${new Date().toISOString().split("T")[0]}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Backup downloaded")
    } catch (e: any) {
      toast.error(e?.message || "Backup failed")
    }
  }

  const runReset = async () => {
    if (!resetTarget) return
    setDeleting(resetTarget.id)
    try {
      const res = await authFetch(`${API}/api/admin/${resetTarget.endpoint}`, { method: "POST" })
      if (!res.ok) throw new Error(await errorMessage(res, "Reset failed"))
      await assertSuccess(res, "Reset failed")
      toast.success(`${resetTarget.label} — done`)
      setResetTarget(null)
      setResetConfirm("")
    } catch (e: any) {
      toast.error(e?.message || "Reset failed")
    } finally {
      setDeleting("")
    }
  }

  const saveS3 = async () => {
    setS3Saving(true)
    try {
      const res = await authFetch(`${API}/api/admin/s3`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s3),
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Save failed"))
      await assertSuccess(res, "Save failed")
      toast.success("S3 settings saved")
    } catch (e: any) {
      toast.error(e?.message || "Failed to save S3 settings")
    } finally {
      setS3Saving(false)
    }
  }

  if (loading) return <LoadingScreen label="Loading settings" />

  const activePreset = SMTP_PRESETS.find((p) => p.host === smtpHost)

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Runtime configuration. These values live in the database, not in the environment file."
      />

      <Toolbar className="gap-0 px-5 py-0">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => select(tab.id)}
            aria-current={active === tab.id ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2.5 text-[length:var(--text-sm)] border-b-2 -mb-px transition-colors",
              active === tab.id
                ? "border-[var(--brand)] text-[var(--text)] font-medium"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
              focusRing
            )}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </Toolbar>

      {active === "users" ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <UsersView />
        </div>
      ) : active === "auth" ? (
        // overflow-y-auto, not hidden: the directory and provider sections
        // expand well past a viewport when both are switched on, and this tab
        // band clips its children otherwise.
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <AuthPanel />
        </div>
      ) : active === "knowledge" ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <KnowledgeView />
        </div>
      ) : (
      <PageBody className="space-y-4">
        {/* ── AI models ── */}
        {active === "models" && (
          <>
            <Card
              title="AI models"
              meta={<Badge tone="neutral">via OpenRouter</Badge>}
              actions={
                <>
                  <Button size="sm" onClick={validateAll} loading={validatingAll}>
                    Validate all
                  </Button>
                  {modelsEditing ? (
                    <>
                      <Button size="sm" variant="primary" onClick={saveModels} loading={modelsSaving} icon={<Save className="w-3 h-3" />}>
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setModelsEditing(false)
                          loadModels()
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => setModelsEditing(true)} icon={<SettingsIcon className="w-3 h-3" />}>
                      Edit
                    </Button>
                  )}
                </>
              }
              padded={false}
            >
              <DataTable
                className="border-0 rounded-none"
                rows={MODEL_ROWS}
                rowKey={(r) => r.key}
                rowTone={(r) => {
                  const t = modelTests[r.key]
                  return t && !t.ok ? "var(--danger-strong)" : null
                }}
                columns={[
                  {
                    key: "label",
                    header: "Purpose",
                    render: (r) => (
                      <span>
                        <span className="block text-[var(--text)]">{r.label}</span>
                        <span className="block text-[length:var(--text-2xs)] text-[var(--text-muted)]">{r.desc}</span>
                      </span>
                    ),
                  },
                  {
                    key: "model",
                    header: "Model",
                    render: (r) =>
                      modelsEditing ? (
                        <Input
                          value={models[r.key] || ""}
                          onChange={(e) => setModels((p) => ({ ...p, [r.key]: e.target.value }))}
                          className="font-mono"
                          aria-label={`${r.label} model`}
                        />
                      ) : (
                        <span className="font-mono text-[var(--text-secondary)]">{models[r.key] || "—"}</span>
                      ),
                  },
                  {
                    key: "status",
                    header: "Status",
                    align: "right",
                    render: (r) => {
                      const t = modelTests[r.key]
                      if (!t) return <span className="text-[var(--text-muted)]">Untested</span>
                      return (
                        <span title={t.msg}>
                          <Badge tone={t.ok ? "ok" : "danger"} dot>
                            {t.ok ? "Verified" : "Failed"}
                          </Badge>
                        </span>
                      )
                    },
                  },
                  {
                    key: "actions",
                    header: "",
                    align: "right",
                    width: "1%",
                    render: (r) => (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => testModel(r.key)}
                        loading={testingModel === r.key}
                        disabled={!models[r.key]}
                      >
                        Test
                      </Button>
                    ),
                  },
                ]}
              />

              {apiKeyStatus && (
                <div className="flex flex-wrap gap-2 px-4 py-3 border-t border-[var(--border)]">
                  {Object.entries(apiKeyStatus).map(([name, info]: [string, any]) => (
                    <Badge key={name} tone={info.set ? "ok" : "danger"} dot>
                      {name.replace("_API_KEY", "").replace("_", " ")}: {info.hint}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="Timezone"
              meta={tzDatetime ? <Badge tone="neutral">{tzDatetime}</Badge> : undefined}
            >
              <p className="mb-3 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                Applied to document dates, activity logs and anything the agent says about &ldquo;today&rdquo;.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  aria-label="Timezone"
                  className={cn(
                    "w-64 bg-[var(--surface)] text-[var(--text)] border border-[var(--border-strong)]",
                    "rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[length:var(--text-sm)] font-mono",
                    focusRing
                  )}
                >
                  {TIMEZONES.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.zones.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <Button variant="primary" onClick={saveTimezone} loading={tzSaving} icon={<Save className="w-3.5 h-3.5" />}>
                  Save
                </Button>
              </div>
            </Card>
          </>
        )}

        {/* ── Email ── */}
        {active === "email" && (
          <Card
            title="SMTP"
            meta={
              smtpHost ? (
                <Badge tone="ok" dot>
                  Configured
                </Badge>
              ) : (
                <Badge tone="warn" dot>
                  Not configured
                </Badge>
              )
            }
          >
            <p className="mb-4 text-[length:var(--text-xs)] text-[var(--text-muted)]">
              Required before the agent can email a generated document to anyone.
            </p>

            <div className="mb-4">
              <p className="mb-1.5 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                Quick setup
              </p>
              <div className="flex flex-wrap gap-1.5">
                {SMTP_PRESETS.map((preset) => (
                  <Button
                    key={preset.name}
                    size="sm"
                    variant={smtpHost === preset.host ? "primary" : "secondary"}
                    onClick={() => {
                      setSmtpHost(preset.host)
                      setSmtpPort(preset.port)
                      toast.success(`Applied the ${preset.name} preset`)
                    }}
                  >
                    {preset.name}
                  </Button>
                ))}
              </div>
              {activePreset?.notes && (
                <div className="mt-2.5">
                  <Notice tone="warn" title={activePreset.name}>
                    {activePreset.notes}
                  </Notice>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5">
              <TextField label="SMTP host" value={smtpHost} onChange={setSmtpHost} placeholder="smtp.gmail.com" mono />
              <TextField label="Port" value={smtpPort} onChange={setSmtpPort} placeholder="587" mono />
              <TextField
                label="Email / username"
                type="email"
                value={smtpUser}
                onChange={setSmtpUser}
                placeholder="you@example.com"
                wide
              />
              <div className="md:col-span-2">
                <label
                  htmlFor="smtp-pass"
                  className="block mb-1 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]"
                >
                  Password / app password
                </label>
                <div className="relative">
                  <Input
                    id="smtp-pass"
                    value={smtpPass}
                    onChange={(e) => setSmtpPass(e.target.value)}
                    type={showPassword ? "text" : "password"}
                    placeholder="App password"
                    className="pr-10"
                  />
                  <div className="absolute right-1 top-1/2 -translate-y-1/2">
                    <IconButton
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowPassword(!showPassword)}
                      icon={showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    />
                  </div>
                </div>
              </div>
              <TextField
                label="From address"
                value={smtpFrom}
                onChange={setSmtpFrom}
                placeholder="noreply@legalscout.com"
                wide
              />
            </div>

            {lastUpdated && (
              <p className="mt-3 text-[length:var(--text-2xs)] text-[var(--text-muted)]">Last saved {lastUpdated}</p>
            )}

            <div className="flex items-end justify-between gap-3 flex-wrap mt-4 pt-4 border-t border-[var(--border)]">
              <Button variant="primary" onClick={saveSettings} loading={saving} icon={<Save className="w-3.5 h-3.5" />}>
                Save settings
              </Button>
              <div className="flex items-end gap-2">
                <div className="w-56">
                  <TextField
                    label="Send a test to"
                    type="email"
                    value={testEmail}
                    onChange={setTestEmail}
                    placeholder="you@example.com"
                  />
                </div>
                <Button
                  onClick={sendTestEmail}
                  loading={testing}
                  disabled={!smtpHost}
                  icon={<Send className="w-3.5 h-3.5" />}
                  className="mb-[1px]"
                >
                  Send test
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* ── System ── */}
        {active === "system" && (
          <>
            <Card title="Health">
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  onClick={async () => {
                    setHealthLoading(true)
                    try {
                      const res = await fetch(`${API}/health`)
                      const data = await res.json()
                      setHealthData(data)
                    } catch (e) {
                      console.error("Health check error:", e)
                      toast.error("Health check failed")
                    } finally {
                      setHealthLoading(false)
                    }
                  }}
                  loading={healthLoading}
                  icon={<Activity className="w-3.5 h-3.5" />}
                >
                  Run health check
                </Button>
                {healthData && (
                  <Badge tone={healthData.status === "healthy" ? "ok" : "danger"} dot>
                    {healthData.status} · DB {healthData.database?.latency_ms}ms · up{" "}
                    {Math.floor((healthData.uptime_seconds || 0) / 60)}m
                  </Badge>
                )}
              </div>

              <div className="mt-4 pt-4 border-t border-[var(--border)]">
                <Button
                  onClick={async () => {
                    setStatsLoading(true)
                    try {
                      const res = await authFetch(`${API}/api/dashboard/stats`)
                      await ensureOk(res, "Failed to load stats")
                      setDbStats(await res.json())
                    } catch (e: any) {
                      toast.error(e?.message || "Failed to load stats")
                    } finally {
                      setStatsLoading(false)
                    }
                  }}
                  loading={statsLoading}
                  icon={<Database className="w-3.5 h-3.5" />}
                >
                  Load database stats
                </Button>
                {dbStats && (
                  <div className="mt-3">
                    <StatRow>
                      <StatTile label="Templates" value={dbStats.templates || 0} />
                      <StatTile label="Companies" value={dbStats.companies || 0} />
                      <StatTile label="Documents" value={dbStats.documents || 0} />
                      <StatTile label="Embeddings" value={dbStats.embeddings || 0} />
                    </StatRow>
                  </div>
                )}
              </div>
            </Card>

            <Card title="Backup & restore">
              <div className="flex flex-wrap items-start gap-3">
                <Button variant="primary" onClick={handleBackup} icon={<Download className="w-3.5 h-3.5" />}>
                  Download a backup
                </Button>

                <label
                  className={cn(
                    "inline-flex items-center gap-1.5 h-9 px-3.5 cursor-pointer",
                    "bg-[var(--surface)] text-[var(--text)] border border-[var(--border-strong)] rounded-[var(--radius-sm)]",
                    "text-[length:var(--text-sm)] font-medium hover:bg-[var(--bg-secondary)] transition-colors",
                    restoring && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <Database className="w-3.5 h-3.5" />
                  {restoring ? "Restoring…" : "Restore from a backup"}
                  <input
                    type="file"
                    accept=".json"
                    className="hidden"
                    disabled={restoring}
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      setRestoring(true)
                      setRestoreResult(null)
                      try {
                        const formData = new FormData()
                        formData.append("file", file)
                        const res = await authFetch(`${API}/api/admin/restore`, { method: "POST", body: formData })
                        if (!res.ok) throw new Error(await errorMessage(res, "Restore failed"))
                        await assertSuccess(res, "Restore failed")
                        const data = await res.json()
                        toast.success(data.message || "Restore complete")
                        setRestoreResult(data.details)
                      } catch (err: any) {
                        toast.error(err?.message || "Failed to restore")
                      } finally {
                        setRestoring(false)
                        e.target.value = ""
                      }
                    }}
                  />
                </label>
              </div>

              <p className="mt-2.5 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                Restoring adds records from the backup. It does not delete what is already there.
              </p>

              {restoreResult && (
                <div className="mt-3">
                  <Notice tone="ok" title="Restored">
                    <ul className="mt-1">
                      {Object.entries(restoreResult).map(([table, count]) => (
                        <li key={table} className="tabular-nums">
                          {table}: {count as number} records
                        </li>
                      ))}
                    </ul>
                  </Notice>
                </div>
              )}
            </Card>

            <Card title="Cloud storage (S3)" meta={s3.enabled ? <Badge tone="ok" dot>Enabled</Badge> : undefined}>
              <Toggle
                checked={s3.enabled}
                onChange={(v) => setS3((prev) => ({ ...prev, enabled: v }))}
                label="Store templates, documents and backups in S3-compatible storage"
                hint="Local filesystem is used when this is off."
              />

              {s3.enabled && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3.5 mt-4">
                    <TextField
                      label="Bucket"
                      value={s3.bucket}
                      onChange={(v) => setS3((p) => ({ ...p, bucket: v }))}
                      placeholder="my-legalscout-bucket"
                      mono
                    />
                    <TextField
                      label="Region"
                      value={s3.region}
                      onChange={(v) => setS3((p) => ({ ...p, region: v }))}
                      placeholder="ap-southeast-1"
                      mono
                    />
                    <TextField
                      label="Access key"
                      value={s3.access_key}
                      onChange={(v) => setS3((p) => ({ ...p, access_key: v }))}
                      placeholder="AKIA…"
                      mono
                    />
                    <TextField
                      label="Secret key"
                      type="password"
                      value={s3.secret_key}
                      onChange={(v) => setS3((p) => ({ ...p, secret_key: v }))}
                      placeholder="••••"
                      mono
                    />
                    <TextField
                      label="Endpoint URL"
                      value={s3.endpoint_url}
                      onChange={(v) => setS3((p) => ({ ...p, endpoint_url: v }))}
                      placeholder="https://minio.example.com"
                      hint="Only for MinIO, Cloudflare R2 or Backblaze B2"
                      wide
                      mono
                    />
                  </div>

                  {s3Status && (
                    <div className="mt-3">
                      <Notice tone={s3Status.ok ? "ok" : "danger"} title={s3Status.ok ? "Connected" : "Connection failed"}>
                        {s3Status.msg}
                      </Notice>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-[var(--border)]">
                    <Button variant="primary" onClick={saveS3} loading={s3Saving} icon={<Save className="w-3.5 h-3.5" />}>
                      Save
                    </Button>
                    <Button
                      onClick={async () => {
                        setS3Testing(true)
                        setS3Status(null)
                        try {
                          // Settings must be persisted before the server can test them.
                          await authFetch(`${API}/api/admin/s3`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(s3),
                          })
                          const res = await authFetch(`${API}/api/admin/s3/test`, { method: "POST" })
                          const data = await res.json()
                          setS3Status({ ok: !!data.success, msg: data.message || data.error || "" })
                        } catch (e) {
                          console.error("S3 test error:", e)
                          setS3Status({ ok: false, msg: "Connection failed" })
                        } finally {
                          setS3Testing(false)
                        }
                      }}
                      loading={s3Testing}
                      icon={<Cloud className="w-3.5 h-3.5" />}
                    >
                      Test connection
                    </Button>
                    <Button
                      onClick={async () => {
                        setS3Syncing(true)
                        try {
                          const res = await authFetch(`${API}/api/admin/s3/sync`, { method: "POST" })
                          if (!res.ok) throw new Error(await errorMessage(res, "Sync failed"))
                          await assertSuccess(res, "Sync failed")
                          const data = await res.json()
                          toast.success(`Synced ${data.synced} files`)
                        } catch (e: any) {
                          toast.error(e?.message || "Sync failed")
                        } finally {
                          setS3Syncing(false)
                        }
                      }}
                      loading={s3Syncing}
                      icon={<Upload className="w-3.5 h-3.5" />}
                    >
                      Upload everything to S3
                    </Button>
                  </div>
                </>
              )}
            </Card>

            <Card title="Danger zone" meta={<Badge tone="danger" dot>Irreversible</Badge>}>
              <Notice tone="danger" title="Take a backup first">
                Nothing here can be undone. Each action asks you to type a confirmation phrase.
              </Notice>
              <ul className="mt-3 space-y-2">
                {RESETS.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-3 flex-wrap px-3 py-2.5 border border-[var(--border)] rounded-[var(--radius-sm)]"
                    style={{ boxShadow: "inset 3px 0 0 0 var(--danger-strong)" }}
                  >
                    <span className="min-w-0">
                      <span className="block text-[length:var(--text-sm)] font-medium text-[var(--text)]">{r.label}</span>
                      <span className="block text-[length:var(--text-xs)] text-[var(--text-muted)]">{r.blurb}</span>
                    </span>
                    <Button
                      variant={r.id === "all" ? "danger" : "secondary"}
                      className={r.id === "all" ? undefined : "text-[var(--danger-strong)]"}
                      onClick={() => {
                        setResetTarget(r)
                        setResetConfirm("")
                      }}
                      disabled={!!deleting}
                      icon={r.id === "all" ? <AlertTriangle className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
                    >
                      {r.id === "all" ? "Delete everything" : "Delete"}
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}

        {/* ── Activity ── */}
        {active === "activity" && (
          <>
            {!activityData ? (
              <div className="py-12 text-center">
                <Button
                  variant="primary"
                  onClick={async () => {
                    setActivityLoading(true)
                    try {
                      const res = await authFetch(`${API}/api/admin/activity?days=30`)
                      await ensureOk(res, "Failed to load activity")
                      setActivityData(await res.json())
                    } catch (e: any) {
                      toast.error(e?.message || "Failed to load activity")
                    } finally {
                      setActivityLoading(false)
                    }
                  }}
                  loading={activityLoading}
                  icon={<BarChart3 className="w-4 h-4" />}
                >
                  Load the last 30 days
                </Button>
              </div>
            ) : (
              <>
                <StatRow>
                  <StatTile label="Events" value={activityData.summary?.total_events || 0} />
                  <StatTile label="Active users" value={Object.keys(activityData.summary?.by_user || {}).length} />
                  <StatTile label="Logins" value={activityData.summary?.by_action?.login || 0} />
                  <StatTile
                    label="Uploads"
                    value={
                      (activityData.summary?.by_action?.upload_template || 0) +
                      (activityData.summary?.by_action?.add_company || 0)
                    }
                  />
                </StatRow>

                <Card title="Events by type">
                  <ul className="space-y-1.5">
                    {Object.entries(activityData.summary?.by_action || {}).map(([action, count]: [string, any]) => {
                      const values = Object.values(activityData.summary?.by_action || {}) as number[]
                      const max = Math.max(...values, 1)
                      const destructive = action.startsWith("reset") || action.startsWith("delete")
                      return (
                        <li key={action} className="flex items-center gap-3">
                          <span className="w-36 shrink-0 text-right text-[length:var(--text-xs)] text-[var(--text-muted)]">
                            {action.replace(/_/g, " ")}
                          </span>
                          <span className="flex-1 h-4 bg-[var(--bg-secondary)] overflow-hidden">
                            <span
                              className="block h-full"
                              style={{
                                width: `${(count / max) * 100}%`,
                                background: destructive ? "var(--danger-strong)" : "var(--brand)",
                              }}
                            />
                          </span>
                          <span className="w-8 text-[length:var(--text-xs)] tabular-nums text-[var(--text)]">
                            {count}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </Card>

                {(activityData.summary?.by_day?.length || 0) > 0 && (
                  <Card title="Daily activity" meta={<Badge tone="neutral">30 days</Badge>}>
                    <div className="overflow-x-auto">
                      <div className="flex items-end gap-1 h-24 min-w-[28rem]">
                        {(activityData.summary?.by_day || []).map((d: any, i: number) => {
                          const max = Math.max(
                            ...(activityData.summary?.by_day || []).map((x: any) => x.count),
                            1
                          )
                          return (
                            <div
                              key={i}
                              className="flex-1 flex flex-col items-center justify-end h-full gap-1"
                              title={`${d.date}: ${d.count} events`}
                            >
                              <span className="text-[length:var(--text-2xs)] tabular-nums text-[var(--text-muted)]">
                                {d.count || ""}
                              </span>
                              <div
                                className="w-full"
                                style={{
                                  height: `${(d.count / max) * 100}%`,
                                  minHeight: d.count > 0 ? 4 : 1,
                                  background: d.count > 0 ? "var(--brand)" : "var(--border)",
                                }}
                              />
                            </div>
                          )
                        })}
                      </div>
                    </div>
                    <div className="flex justify-between mt-1.5 text-[length:var(--text-2xs)] text-[var(--text-muted)] tabular-nums">
                      <span>{activityData.summary?.by_day?.[0]?.date}</span>
                      <span>{activityData.summary?.by_day?.slice(-1)[0]?.date}</span>
                    </div>
                  </Card>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[
                    ["Templates", activityData.recent?.templates || [], (x: any) => [x.name, x.uploaded_by]],
                    ["Companies", activityData.recent?.companies || [], (x: any) => [x.name, x.created_by]],
                    ["Documents", activityData.recent?.documents || [], (x: any) => [x.file, x.created_by]],
                  ].map(([title, items, pick]: any) => (
                    <Card key={title} title={title} meta={<Badge tone="neutral">{items.length}</Badge>}>
                      {items.length === 0 ? (
                        <p className="text-[length:var(--text-xs)] text-[var(--text-muted)]">Nothing recent.</p>
                      ) : (
                        <ul className="space-y-2 max-h-48 overflow-y-auto">
                          {items.map((x: any, i: number) => {
                            const [name, by] = pick(x)
                            return (
                              <li key={i} className="min-w-0">
                                <p className="text-[length:var(--text-xs)] font-medium text-[var(--text)] truncate">
                                  {name}
                                </p>
                                <p className="flex items-center gap-1 text-[length:var(--text-2xs)] text-[var(--text-muted)]">
                                  <User className="w-3 h-3" /> {by || "—"}
                                </p>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </Card>
                  ))}
                </div>

                <Card
                  title="Event log"
                  meta={<Badge tone="neutral">{(activityData.logs || []).length}</Badge>}
                  actions={
                    <Button size="sm" variant="ghost" onClick={() => setActivityData(null)}>
                      Reload
                    </Button>
                  }
                  padded={false}
                >
                  <DataTable
                    className="border-0 rounded-none"
                    maxHeight="24rem"
                    rows={activityData.logs || []}
                    rowKey={(l: any) => l.id}
                    rowTone={(l: any) => (l.action?.startsWith("reset") ? "var(--danger-strong)" : null)}
                    empty={<span className="text-[var(--text-muted)]">No activity recorded yet.</span>}
                    columns={[
                      {
                        key: "time",
                        header: "Time",
                        sortValue: (l: any) => dateSort(l.time),
                        render: (l: any) => (
                          <span className="tabular-nums whitespace-nowrap text-[var(--text-muted)]">
                            {formatDateTime(l.time)}
                          </span>
                        ),
                      },
                      { key: "user", header: "User", sortValue: (l: any) => l.user, render: (l: any) => l.user || "—" },
                      {
                        key: "action",
                        header: "Action",
                        sortValue: (l: any) => l.action,
                        render: (l: any) => {
                          const tone: Tone = l.action?.startsWith("reset")
                            ? "danger"
                            : l.action?.startsWith("upload")
                              ? "ok"
                              : l.action?.startsWith("add")
                                ? "accent"
                                : l.action === "login"
                                  ? "info"
                                  : "neutral"
                          return <Badge tone={tone}>{l.action?.replace(/_/g, " ")}</Badge>
                        },
                      },
                      {
                        key: "details",
                        header: "Details",
                        hideBelow: "md",
                        render: (l: any) => <span className="block max-w-[280px] truncate">{l.details || "—"}</span>,
                      },
                    ]}
                  />
                </Card>

                {Object.keys(activityData.summary?.by_user || {}).length > 0 && (
                  <Card title="Activity by user">
                    <ul className="space-y-1.5">
                      {Object.entries(activityData.summary?.by_user || {}).map(([user, count]: [string, any]) => (
                        <li key={user} className="flex items-center justify-between gap-3">
                          <span className="flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--text)]">
                            <User className="w-3.5 h-3.5 text-[var(--text-muted)]" /> {user}
                          </span>
                          <span className="text-[length:var(--text-xs)] tabular-nums text-[var(--text-muted)]">
                            {count} events
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </PageBody>
      )}

      {/* Typed confirmation for every destructive reset. */}
      <Modal
        open={!!resetTarget}
        onOpenChange={(o) => {
          if (!o) {
            setResetTarget(null)
            setResetConfirm("")
          }
        }}
        size="sm"
        title={resetTarget?.label || ""}
        description={resetTarget?.blurb}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setResetTarget(null)
                setResetConfirm("")
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={runReset}
              loading={!!deleting}
              disabled={resetConfirm !== resetTarget?.phrase}
            >
              {resetTarget?.label}
            </Button>
          </>
        }
      >
        <Notice tone="danger" title="This cannot be undone">
          Download a backup from the System tab first if you are not certain.
        </Notice>
        <p className="mt-3 mb-1.5 text-[length:var(--text-sm)] text-[var(--text)]">
          Type <span className="font-mono font-semibold">{resetTarget?.phrase}</span> to confirm.
        </p>
        <Input
          value={resetConfirm}
          onChange={(e) => setResetConfirm(e.target.value)}
          placeholder={resetTarget?.phrase}
          aria-label={`Type ${resetTarget?.phrase} to confirm`}
        />
      </Modal>
    </Page>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<LoadingScreen label="Loading settings" />}>
      <SettingsInner />
    </Suspense>
  )
}
