"use client"

import React, { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  Download,
  Eye,
  FileText,
  Loader2,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react"
import apiClient, { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import { useActivityTray } from "@/hooks/useActivityTray"
import { kickTrainingPoll } from "@/hooks/useTrainingJob"
import DocViewer from "@/components/ui/DocViewer"
import { cn } from "@/lib/utils"
import {
  Badge,
  Button,
  Card,
  type Column,
  ConfirmButton,
  DataTable,
  DetailList,
  EmptyState,
  IconButton,
  Input,
  LoadingScreen,
  Modal,
  Notice,
  Page,
  PageBody,
  PageHeader,
  SearchInput,
  StatRow,
  StatTile,
  type Tone,
  Toolbar,
  assertSuccess,
  ensureOk,
  errorMessage,
  formatDateTime,
} from "@/components/ui/kit"
import {
  TrainingProgress,
  applyStepEvent,
  freshSteps,
  type PipelineStep,
} from "../components/TrainingProgress"

interface Template {
  name: string
  path: string
  fields: any
  total_fields: number
  category?: string
  keywords?: string
  description?: string
  purpose?: string
  when_to_use?: string
  how_to_use?: any[]
  prerequisites?: any[]
  filing_deadline?: string
  fees?: string
  validity_period?: string
  approval_chain?: any[]
  required_attachments?: any[]
  common_mistakes?: any[]
  jurisdiction?: string
  industry_tags?: any[]
  complexity?: string
  estimated_time?: string
  ai_trained?: boolean
  ai_analyzed?: boolean
  uploaded_by_email?: string
  training_confidence?: number
  template_group?: string | null
}

const SETUP_GROUP = "new_company_setup"

interface TerminalLine {
  id: number
  text: string
  type: "info" | "success" | "error" | "processing" | "ai"
  timestamp: string
}

const isTrained = (t: Template) => !!(t.ai_trained || t.ai_analyzed)

const confidenceTone = (n: number): Tone => (n >= 80 ? "ok" : n >= 50 ? "warn" : "danger")

const LINE_TONE: Record<TerminalLine["type"], string> = {
  success: "text-[var(--ok-strong)]",
  error: "text-[var(--danger-strong)]",
  processing: "text-[var(--warn)]",
  ai: "text-[var(--brand)]",
  info: "text-[var(--text-secondary)]",
}

/** Chip list used for prerequisites, attachments, approvals. */
function ChipList({ items, tone = "neutral" }: { items: any[]; tone?: Tone }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <Badge key={i} tone={tone}>
          {typeof item === "string" ? item : item?.name || JSON.stringify(item)}
        </Badge>
      ))}
    </div>
  )
}

export default function TemplatesView() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState("")

  const [isTraining, setIsTraining] = useState(false)
  const [trainingComplete, setTrainingComplete] = useState(false)
  const [trainingStale, setTrainingStale] = useState(false)
  const [lastTrained, setLastTrained] = useState<string | null>(null)
  const [terminalLogs, setTerminalLogs] = useState<TerminalLine[]>([])
  const [showLogModal, setShowLogModal] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)

  // Starting a run no longer opens a modal over this page. The job already
  // survived the tab closing; what it did not survive was the UI, because the
  // only way to watch it covered the page it was training from. Progress goes
  // to the docked tray instead, and the modal below stays for the transcript.
  const openActivity = useActivityTray((s) => s.openTab)

  // Live view of the 15-step pipeline for the template being trained.
  const [steps, setSteps] = useState<PipelineStep[]>(freshSteps())
  const [currentTemplate, setCurrentTemplate] = useState<string>("")
  const [queuePos, setQueuePos] = useState({ index: 0, total: 0 })

  const [uploading, setUploading] = useState(false)
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false)
  const [deleteAllConfirm, setDeleteAllConfirm] = useState("")
  const [deletingAll, setDeletingAll] = useState(false)
  const [duplicateError, setDuplicateError] = useState<{
    name: string
    error: string
    existing?: { name: string; fields: number; category: string; trained: boolean; uploaded_at: string | null }
  } | null>(null)

  const terminalRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Training now runs server-side. These only drive POLLING of the job — the
  // timer may be cleared freely; that stops polling but NEVER the server job.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollingRef = useRef(false)
  const lastStatusRef = useRef<string>("")

  useEffect(() => {
    fetchTemplates()
    checkTrainingStatus()
    attachIfActive()
    // Clearing the poll timer on unmount only stops us watching — the
    // server-side job keeps running regardless.
    return () => stopPolling()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight
  }, [terminalLogs])

  useEffect(() => {
    if (trainingComplete && terminalLogs.length > 0 && !isTraining) {
      authFetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/training/save-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "templates", logs: terminalLogs }),
      }).catch((e) => console.error("Save training logs error:", e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainingComplete])

  const checkTrainingStatus = async () => {
    try {
      const res = await authFetch(apiClient.getTrainingStatus())
      await ensureOk(res, "Failed to read training status")
      const data = await res.json()
      const t = data.data?.templates
      if (!t) return
      if (t.last_trained) setLastTrained(new Date(t.last_trained).toLocaleString())
      if (t.status === "stale") {
        setTrainingStale(true)
        setTrainingComplete(false)
      }
      if (t.logs?.length > 0) {
        setTerminalLogs(t.logs)
        if (t.status !== "stale") setTrainingComplete(true)
      }
    } catch (e) {
      console.error("Training status check error:", e)
    }
  }

  const fetchTemplates = async () => {
    try {
      setError(null)
      const res = await authFetch(apiClient.getDashboardTemplates())
      await ensureOk(res, "Failed to load templates")
      const data = await res.json()
      setTemplates(data.templates || [])
    } catch (e: any) {
      console.error("Failed to fetch templates:", e)
      setError(e?.message || "Failed to load templates")
    } finally {
      setLoading(false)
    }
  }

  // Tag / untag a template as part of the new-company setup set, so the chat
  // agent offers ONLY these when a new company is being set up.
  const toggleSetupGroup = async (t: Template) => {
    const nextGroup = t.template_group === SETUP_GROUP ? null : SETUP_GROUP
    // optimistic update
    setTemplates((prev) =>
      prev.map((x) => (x.name === t.name ? { ...x, template_group: nextGroup } : x)),
    )
    try {
      const res = await authFetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/templates/group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_name: t.name, template_group: nextGroup }),
      })
      await ensureOk(res, "Failed to update template group")
    } catch (e) {
      console.error("Failed to toggle setup group:", e)
      await fetchTemplates() // revert to server truth
    }
  }

  const untrained = useMemo(() => templates.filter((t) => !isTrained(t)), [templates])

  // ── Server-side training: start + poll ────────────────────────────────
  // The whole run lives on the server now. The FE only starts a job and then
  // polls its state; closing the modal, the tab, or the browser no longer
  // affects the run. Reopening the page re-attaches to the live job.

  const LEVEL_TO_TYPE: Record<string, TerminalLine["type"]> = {
    success: "success",
    error: "error",
    processing: "processing",
    ai: "ai",
    info: "info",
  }

  /** Fold a polled job into the visual pipeline + transcript + progress. */
  const syncFromJob = (job: any) => {
    const status: string = job?.status || "idle"
    if (status === "idle") {
      setIsTraining(false)
      lastStatusRef.current = "idle"
      return
    }

    const logs: any[] = Array.isArray(job.logs) ? job.logs : []

    // Rebuild the visual pipeline exactly as the old SSE loop did: reset on
    // each template boundary, then fold every real pipeline event in.
    let pipe = freshSteps()
    for (const e of logs) {
      if (e?.step === "template_start") pipe = freshSteps()
      else pipe = applyStepEvent(pipe, e?.step || "", e?.msg || "")
    }
    setSteps(pipe)

    // Rebuild the transcript from the job's logs (stable index ids).
    setTerminalLogs(
      logs.map((e, i) => ({
        id: i,
        text: e?.msg || e?.step || "",
        type: LEVEL_TO_TYPE[e?.level] || "info",
        timestamp: e?.ts ? new Date(e.ts).toLocaleTimeString("en-US", { hour12: false }) : "",
      })),
    )

    setCurrentTemplate(job.current_template || "")
    const total: number = job.total || 0
    const pos = status === "done" ? total : Math.min((job.current_index || 0) + 1, total)
    setQueuePos({ index: pos, total })

    const active = status === "running" || status === "queued"
    setIsTraining(active)

    const prev = lastStatusRef.current
    lastStatusRef.current = status

    if (!active) {
      stopPolling()
      const justFinished = prev === "running" || prev === "queued"
      if (status === "done") {
        setTrainingComplete(true)
        setTrainingStale(false)
        if (justFinished) {
          setLastTrained(new Date().toLocaleString())
          fetchTemplates()
          toast.success(
            `Training complete — ${job.done_count}/${total} trained${
              job.fail_count ? `, ${job.fail_count} failed` : ""
            }`,
          )
        }
      } else if (status === "error" && justFinished) {
        toast.error(job.error || "Training failed")
      } else if (status === "cancelled" && justFinished) {
        toast.info("Training cancelled")
      }
    }
  }

  const stopPolling = () => {
    pollingRef.current = false
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }

  const startPolling = () => {
    if (pollingRef.current) return // never run two pollers at once
    pollingRef.current = true
    const tick = async () => {
      if (!pollingRef.current) return
      try {
        const res = await authFetch(apiClient.trainJob())
        if (res.ok) syncFromJob(await res.json())
      } catch (e) {
        console.error("Training poll error:", e)
      }
      if (pollingRef.current) pollTimerRef.current = setTimeout(tick, 1500)
    }
    tick()
  }

  /** On mount / on opening the log: show the live-or-most-recent job. */
  const attachIfActive = async () => {
    try {
      const res = await authFetch(apiClient.trainJob())
      if (!res.ok) return
      const job = await res.json()
      if (!job || job.status === "idle") return
      syncFromJob(job)
      if (job.status === "running" || job.status === "queued") startPolling()
    } catch (e) {
      console.error("Training attach error:", e)
    }
  }

  const startTraining = async (trainAll = false) => {
    setTrainingComplete(false)
    openActivity("training")
    lastStatusRef.current = ""
    try {
      const res = await authFetch(apiClient.trainStart(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retrain_all: trainAll }),
      })
      if (!res.ok) {
        toast.error(await errorMessage(res, "Could not start training"))
        return
      }
      const data = await res.json()
      if (data?.status === "nothing_to_train") {
        toast.info("Every template is already trained. Use Retrain all to run them again.")
        return
      }
      setIsTraining(true)
      setQueuePos({ index: 0, total: data?.total || 0 })
      startPolling()
      // Pull the tray's first status now — its idle interval is 20s, and a
      // panel that appears a beat after the click reads as a dead button.
      kickTrainingPoll()
    } catch (e: any) {
      console.error("Start training error:", e)
      toast.error(e?.message || "Could not start training")
    }
  }

  // Cancels the SERVER job (worker stops between templates). Does not tear
  // down anything locally — the poll reflects the cancelled state.
  const stopTraining = async () => {
    try {
      await authFetch(apiClient.trainCancel(), { method: "POST" })
      toast.info("Cancelling — training stops after the current template")
    } catch (e) {
      console.error("Cancel training error:", e)
    }
  }

  const deleteTemplate = async (template: Template) => {
    try {
      const res = await authFetch(apiClient.deleteTemplate(template.name), { method: "DELETE" })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to delete template"))
      await assertSuccess(res, "Failed to delete template")
      const data = await res.json()
      if (data.training_invalidated) {
        setTrainingStale(true)
        setTrainingComplete(false)
      }
      toast.success(`"${template.name}" deleted`)
      if (selectedTemplate?.name === template.name) setSelectedTemplate(null)
      await fetchTemplates()
    } catch (e: any) {
      console.error("Failed to delete:", e)
      toast.error(e?.message || "Failed to delete template")
    }
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setUploading(true)
    let uploaded = 0
    try {
      for (const file of Array.from(files)) {
        if (!/\.(doc|docx|pdf)$/i.test(file.name)) {
          toast.error(`${file.name} is not a .doc, .docx or .pdf file`)
          continue
        }
        const formData = new FormData()
        formData.append("file", file)
        const res = await authFetch(apiClient.uploadTemplate(), { method: "POST", body: formData })
        if (!res.ok) throw new Error(await errorMessage(res, "Upload failed"))
        const data = await res.json()
        if (!data.success) {
          if (data.exists) {
            setDuplicateError({ name: file.name, error: data.error, existing: data.existing_template })
          } else {
            toast.error(data.error || "Upload failed")
          }
        } else {
          uploaded += 1
        }
      }
      await fetchTemplates()

      // An untrained template is invisible to the agent, so uploading without
      // training is never what anyone wants. Kick off the background job for
      // whatever is still untrained — it survives closing this tab.
      if (uploaded > 0) {
        toast.success(
          `${uploaded} template${uploaded === 1 ? "" : "s"} uploaded — training started`
        )
        await startTraining(false)
      }
    } catch (err: any) {
      console.error("Failed to upload:", err)
      toast.error(err?.message || "Failed to upload template")
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const deleteAllTemplates = async () => {
    setDeletingAll(true)
    try {
      const res = await authFetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/admin/reset/templates`, {
        method: "POST",
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to delete templates"))
      await assertSuccess(res, "Failed to delete templates")
      toast.success("All templates deleted")
      await fetchTemplates()
      setShowDeleteAllModal(false)
      setDeleteAllConfirm("")
    } catch (e: any) {
      console.error("Delete all error:", e)
      toast.error(e?.message || "Failed to delete templates")
    } finally {
      setDeletingAll(false)
    }
  }

  const term = searchTerm.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      term
        ? templates.filter(
            (t) =>
              t.name.toLowerCase().includes(term) ||
              (t.category || "").toLowerCase().includes(term) ||
              (t.keywords || "").toLowerCase().includes(term)
          )
        : templates,
    [templates, term]
  )

  const stats = useMemo(() => {
    const trained = templates.filter(isTrained)
    const confidences = trained.map((t) => t.training_confidence || 0).filter((n) => n > 0)
    const avg = confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0
    const lowConfidence = trained.filter((t) => (t.training_confidence || 0) > 0 && (t.training_confidence || 0) < 50).length
    return { total: templates.length, trained: trained.length, untrained: untrained.length, avg, lowConfidence }
  }, [templates, untrained])

  if (loading) return <LoadingScreen label="Loading templates" />

  const hiddenInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".doc,.docx,.pdf"
      multiple
      onChange={handleUpload}
      className="hidden"
    />
  )

  // ── Training modal, available from either view ──
  const trainingModal = (
    <Modal
      open={showLogModal}
      onOpenChange={setShowLogModal}
      size="lg"
      title="Template training"
      description="Sixteen stages per template, numbered 1 to 15 — 5.5 is a real half-step. Each one is an AI or database stage the agent later reads from."
      footer={
        <>
          {isTraining ? (
            <Button variant="danger" onClick={stopTraining} icon={<Square className="w-3.5 h-3.5" />}>
              Stop training
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setShowLogModal(false)}>
              Close
            </Button>
          )}
          <Button onClick={() => setShowTranscript((s) => !s)} icon={<Terminal className="w-3.5 h-3.5" />}>
            {showTranscript ? "Hide transcript" : `Transcript (${terminalLogs.length})`}
          </Button>
        </>
      }
    >
      {!isTraining && terminalLogs.length === 0 ? (
        <p className="py-8 text-center text-[length:var(--text-sm)] text-[var(--text-muted)]">
          No training run yet. Start training to watch the pipeline.
        </p>
      ) : (
        <div className="space-y-3">
          <TrainingProgress
            steps={steps}
            templateName={currentTemplate}
            index={queuePos.index || undefined}
            total={queuePos.total || undefined}
            running={isTraining}
          />

          {showTranscript && (
            <div
              ref={terminalRef}
              role="log"
              aria-live="polite"
              className="max-h-64 overflow-y-auto p-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-sm)] font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] leading-5"
            >
              {terminalLogs.map((log) => (
                <div key={log.id} className="flex gap-2">
                  <span className="text-[var(--text-muted)] shrink-0 tabular-nums">{log.timestamp}</span>
                  <span className={cn("whitespace-pre-wrap break-words", LINE_TONE[log.type])}>{log.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )

  // ── Template detail ──
  if (selectedTemplate) {
    const t = selectedTemplate
    const confidence = t.training_confidence || 0

    let fields: any = t.fields
    if (typeof fields === "string") {
      try {
        fields = JSON.parse(fields)
      } catch {
        fields = []
      }
    }
    // Classified when the object carries either field bucket. (An empty
    // db_fields array is truthy in JS, so also accept user_input_fields.)
    const classified =
      !!fields && !Array.isArray(fields) &&
      (Array.isArray(fields.db_fields) || Array.isArray(fields.user_input_fields))
    const dbFields: string[] = classified ? fields.db_fields || [] : []
    const userFields: string[] = classified ? fields.user_input_fields || [] : []
    const rawFields: any[] = Array.isArray(fields)
      ? fields
      : fields?.all_fields || fields?.fields || []
    const deepAnalysis = (t as any).field_deep_analysis || {}
    const workflow = (t as any).document_workflow
    const relations: any[] = (t as any).cross_template_relationships || []
    const sample = (t as any).sample_filled_document || {}

    return (
      <>
        {hiddenInput}
        <Page>
          <PageHeader
            back={
              <IconButton
                aria-label="Back to templates"
                onClick={() => setSelectedTemplate(null)}
                icon={<ArrowLeft className="w-4 h-4" />}
              />
            }
            title={t.name}
            meta={
              <>
                {isTrained(t) ? (
                  <Badge tone="ok" dot>
                    Trained
                  </Badge>
                ) : (
                  <Badge tone="warn" dot>
                    Untrained
                  </Badge>
                )}
                {confidence > 0 && <Badge tone={confidenceTone(confidence)}>{confidence}% confidence</Badge>}
                <Badge tone="neutral">{t.total_fields || rawFields.length || 0} placeholders</Badge>
              </>
            }
            actions={
              <>
                <Button
                  onClick={() => window.open(apiClient.downloadTemplate(t.name), "_blank")}
                  icon={<Download className="w-3.5 h-3.5" />}
                >
                  Download
                </Button>
                <Button variant="primary" onClick={() => window.open("/", "_blank")}>
                  Generate document
                </Button>
              </>
            }
          />

          {/* ONE scroll region for the whole detail — the preview no longer has
              its own overflow box, so the wheel scrolls the page as a unit. The
              metadata panel sticks to the top while the (taller) PDF scrolls. */}
          <div className="flex flex-1 min-h-0 overflow-y-auto split-view-mobile">
            <div className="w-1/2 flex flex-col min-w-0 border-r border-[var(--border)]">
              <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
                <Eye className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                <span className="text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)]">
                  Preview — placeholders highlighted
                </span>
              </div>
              <DocViewer
                url={`${apiClient.previewTemplatePdf(t.name)}?token=${
                  typeof window !== "undefined" ? localStorage.getItem("ls_token") || "" : ""
                }`}
                forceFormat="pdf"
                className="w-full"
              />
            </div>

            <div className="w-1/2 flex flex-col min-w-0 bg-[var(--bg-secondary)]">
              <div className="p-4 space-y-3">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                  {[
                    ["Category", t.category],
                    ["Complexity", t.complexity],
                    ["Est. time", t.estimated_time],
                    ["Jurisdiction", t.jurisdiction],
                  ].map(([label, value]) => (
                    <div
                      key={label as string}
                      className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-sm)] px-3 py-2 min-w-0"
                    >
                      <p className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                        {label}
                      </p>
                      <p className="mt-0.5 text-[length:var(--text-sm)] text-[var(--text)] truncate">
                        {(value as string) || "Not set"}
                      </p>
                    </div>
                  ))}
                </div>

                {confidence > 0 && (
                  <Card title="Training confidence">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-1.5 bg-[var(--bg-secondary)] overflow-hidden">
                        <div
                          className="h-full"
                          style={{
                            width: `${confidence}%`,
                            background:
                              confidence >= 80
                                ? "var(--ok-strong)"
                                : confidence >= 50
                                  ? "var(--warn)"
                                  : "var(--danger-strong)",
                          }}
                        />
                      </div>
                      <span className="font-[family-name:var(--font-display)] text-[length:var(--text-lg)] font-semibold tabular-nums text-[var(--text)]">
                        {confidence}%
                      </span>
                    </div>
                    <p className="mt-2 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                      Share of the fifteen training steps that completed cleanly for this template.
                    </p>
                  </Card>
                )}

                <Card title="Purpose">
                  <p className="text-[length:var(--text-sm)] text-[var(--text)]">
                    {t.purpose || t.description || "Not set"}
                  </p>
                  {t.when_to_use && (
                    <>
                      <p className="mt-3 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                        When to use
                      </p>
                      <p className="mt-0.5 text-[length:var(--text-sm)] text-[var(--text)]">{t.when_to_use}</p>
                    </>
                  )}
                </Card>

                {t.how_to_use && t.how_to_use.length > 0 && (
                  <Card title="How to use">
                    <ol className="space-y-1.5">
                      {t.how_to_use.map((step: any, i: number) => (
                        <li key={i} className="flex gap-2.5 text-[length:var(--text-sm)]">
                          <span className="w-5 h-5 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] text-[length:var(--text-2xs)] tabular-nums text-[var(--text-secondary)]">
                            {i + 1}
                          </span>
                          <span className="text-[var(--text)]">{step}</span>
                        </li>
                      ))}
                    </ol>
                  </Card>
                )}

                <Card title="Placeholders" meta={<Badge tone="neutral">{classified ? dbFields.length + userFields.length : rawFields.length}</Badge>}>
                  {classified ? (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {dbFields.map((f, i) => (
                          <Badge key={`db-${i}`} tone="ok" dot>
                            {f}
                          </Badge>
                        ))}
                        {userFields.map((f, i) => (
                          <Badge key={`ui-${i}`} tone="accent" dot>
                            {f}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--text-2xs)] text-[var(--text-muted)]">
                        <span>Auto-filled from the database ({dbFields.length})</span>
                        <span>Asked of the user ({userFields.length})</span>
                      </p>

                      {fields.field_descriptions && Object.keys(fields.field_descriptions).length > 0 && (
                        <dl className="mt-3 pt-3 border-t border-[var(--border)] space-y-1">
                          {Object.entries(fields.field_descriptions).map(([key, desc]: [string, any]) => (
                            <div key={key} className="flex gap-2 text-[length:var(--text-xs)]">
                              <dt className="font-medium text-[var(--text)] shrink-0 font-mono">{key}</dt>
                              <dd className="text-[var(--text-muted)]">{desc}</dd>
                            </div>
                          ))}
                        </dl>
                      )}

                      {fields.static_text_warnings?.length > 0 && (
                        <div className="mt-3">
                          <Notice tone="warn" title="Static text warnings">
                            <ul className="mt-1 space-y-0.5">
                              {fields.static_text_warnings.map((w: string, i: number) => (
                                <li key={i}>{w}</li>
                              ))}
                            </ul>
                          </Notice>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="mb-2 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                        Not classified yet. Train this template to split placeholders into auto-filled and user-input.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {rawFields.map((f: any, i: number) => (
                          <Badge key={i} tone="neutral">
                            {typeof f === "string" ? f : f.name || JSON.stringify(f)}
                          </Badge>
                        ))}
                      </div>
                    </>
                  )}
                </Card>

                {Object.keys(deepAnalysis).length > 0 && (
                  <Card title="Field analysis" padded={false}>
                    <DataTable
                      maxHeight="16rem"
                      className="border-0 rounded-none"
                      rows={Object.entries(deepAnalysis).map(([name, info]: [string, any]) => ({ name, ...info }))}
                      rowKey={(r: any) => r.name}
                      columns={[
                        { key: "name", header: "Field", render: (r: any) => <span className="font-mono">{r.name}</span> },
                        { key: "data_type", header: "Type", render: (r: any) => r.data_type || "—" },
                        { key: "format", header: "Format", hideBelow: "sm", render: (r: any) => r.format || "—" },
                        {
                          key: "required",
                          header: "Required",
                          align: "right",
                          render: (r: any) =>
                            r.required ? <Badge tone="danger">Required</Badge> : <Badge tone="neutral">Optional</Badge>,
                        },
                      ]}
                    />
                  </Card>
                )}

                {(t.prerequisites?.length || t.required_attachments?.length || t.approval_chain?.length) ? (
                  <Card title="Before you file">
                    <div className="space-y-3">
                      {t.prerequisites && t.prerequisites.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                            Prerequisites
                          </p>
                          <ChipList items={t.prerequisites} tone="warn" />
                        </div>
                      )}
                      {t.required_attachments && t.required_attachments.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                            Required attachments
                          </p>
                          <ChipList items={t.required_attachments} tone="ok" />
                        </div>
                      )}
                      {t.approval_chain && t.approval_chain.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                            Approval chain
                          </p>
                          <ChipList items={t.approval_chain} tone="info" />
                        </div>
                      )}
                    </div>
                  </Card>
                ) : null}

                <Card title="Filing">
                  <DetailList
                    items={[
                      ["Filing deadline", t.filing_deadline || "Not set"],
                      ["Fees", t.fees || "Not set"],
                      ["Validity period", t.validity_period || "Not set"],
                      ["Keywords", t.keywords || "Not set"],
                    ]}
                  />
                </Card>

                {t.common_mistakes && t.common_mistakes.length > 0 && (
                  <Notice tone="danger" title="Common mistakes">
                    <ul className="mt-1 space-y-0.5">
                      {t.common_mistakes.map((m: any, i: number) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </Notice>
                )}

                {workflow && (
                  <Card title="Document workflow">
                    {workflow.trigger && (
                      <p className="mb-2 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                        Trigger: {workflow.trigger}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {(workflow.before || []).map((d: string, i: number) => (
                        <Badge key={`b${i}`} tone="info">
                          {d}
                        </Badge>
                      ))}
                      {(workflow.before || []).length > 0 && <span className="text-[var(--text-muted)]">→</span>}
                      <Badge tone="accent" solid>
                        {t.name.replace(".docx", "")}
                      </Badge>
                      {(workflow.after || []).length > 0 && <span className="text-[var(--text-muted)]">→</span>}
                      {(workflow.after || []).map((d: string, i: number) => (
                        <Badge key={`a${i}`} tone="ok">
                          {d}
                        </Badge>
                      ))}
                    </div>
                  </Card>
                )}

                {relations.length > 0 && (
                  <Card title="Related templates">
                    <ul className="space-y-1.5">
                      {relations.map((rel: any, i: number) => (
                        <li key={i} className="flex items-center gap-2 text-[length:var(--text-xs)] flex-wrap">
                          <Badge
                            tone={
                              rel.relationship === "prerequisite"
                                ? "info"
                                : rel.relationship === "follow_up"
                                  ? "ok"
                                  : rel.relationship === "alternative"
                                    ? "warn"
                                    : "neutral"
                            }
                          >
                            {rel.relationship}
                          </Badge>
                          <span className="font-medium text-[var(--text)]">{rel.template}</span>
                          <span className="text-[var(--text-muted)]">{rel.description}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}

                {Object.keys(sample).length > 0 && (
                  <Card title="Sample values" meta={<Badge tone="neutral">AI generated</Badge>}>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                      {Object.entries(sample)
                        .slice(0, 12)
                        .map(([key, val]: [string, any]) => (
                          <div key={key} className="flex gap-2 text-[length:var(--text-xs)] min-w-0">
                            <dt className="text-[var(--text-muted)] font-mono shrink-0">{key}</dt>
                            <dd className="text-[var(--text)] truncate">{String(val)}</dd>
                          </div>
                        ))}
                    </dl>
                  </Card>
                )}
              </div>
            </div>
          </div>
        </Page>
        {trainingModal}
      </>
    )
  }

  // ── List ──
  const columns: Column<Template>[] = [
    {
      key: "name",
      header: "Template",
      sortValue: (t) => t.name,
      render: (t) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-7 h-7 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-sm)]">
            <FileText className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-[var(--text)] truncate max-w-[280px]">{t.name}</span>
            {t.category && (
              <span className="block text-[length:var(--text-2xs)] text-[var(--text-muted)]">{t.category}</span>
            )}
          </span>
        </div>
      ),
    },
    {
      key: "total_fields",
      header: "Placeholders",
      numeric: true,
      sortValue: (t) => t.total_fields || 0,
      render: (t) => t.total_fields || t.fields?.length || 0,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (t) => (isTrained(t) ? 1 : 0),
      render: (t) =>
        isTrained(t) ? (
          <Badge tone="ok" dot>
            Trained
          </Badge>
        ) : (
          <Badge tone="warn" dot>
            Untrained
          </Badge>
        ),
    },
    {
      key: "template_group",
      header: "Setup set",
      stopClickPropagation: true,
      sortValue: (t) => (t.template_group === SETUP_GROUP ? 1 : 0),
      render: (t) => (
        <button
          type="button"
          onClick={() => toggleSetupGroup(t)}
          title={
            t.template_group === SETUP_GROUP
              ? "In the new-company setup set — click to remove"
              : "Add to the new-company setup set (agent shows only these when setting up a new company)"
          }
          className="cursor-pointer"
        >
          {t.template_group === SETUP_GROUP ? (
            <Badge tone="accent" dot>
              Setup
            </Badge>
          ) : (
            <Badge tone="neutral">+ Add</Badge>
          )}
        </button>
      ),
    },
    {
      key: "training_confidence",
      header: "Confidence",
      align: "right",
      sortValue: (t) => t.training_confidence || null,
      render: (t) =>
        t.training_confidence ? (
          <Badge tone={confidenceTone(t.training_confidence)}>{t.training_confidence}%</Badge>
        ) : (
          <span className="text-[var(--text-muted)]">—</span>
        ),
    },
    {
      key: "uploaded_by_email",
      header: "Uploaded by",
      hideBelow: "lg",
      sortValue: (t) => t.uploaded_by_email,
      render: (t) => t.uploaded_by_email || "—",
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "1%",
      stopClickPropagation: true,
      render: (t) => (
        <ConfirmButton
          compact
          label={`Delete ${t.name}`}
          icon={<Trash2 className="w-3.5 h-3.5" />}
          onConfirm={() => deleteTemplate(t)}
        />
      ),
    },
  ]

  return (
    <>
      {hiddenInput}
      <Page>
        <PageHeader
          title="Templates"
          meta={
            <>
              <Badge tone="neutral">{templates.length}</Badge>
              {isTraining && (
                <Badge tone="warn" dot>
                  Training {queuePos.index}/{queuePos.total}
                </Badge>
              )}
              {trainingStale && !isTraining && (
                <Badge tone="warn" dot>
                  Out of date
                </Badge>
              )}
            </>
          }
          description="Word templates the agent fills. Training reads each one through a sixteen-stage pipeline so the agent knows what it is for and which fields it needs."
          actions={
            <>
              <Button
                onClick={() => {
                  setShowLogModal(true)
                  attachIfActive()
                }}
                icon={<Terminal className="w-4 h-4" />}
              >
                {isTraining ? "View progress" : "Training log"}
              </Button>
              <Button
                onClick={() => startTraining(false)}
                loading={isTraining}
                disabled={templates.length === 0}
                icon={<Sparkles className="w-4 h-4" />}
              >
                {isTraining ? "Training" : untrained.length > 0 ? `Train new (${untrained.length})` : "Retrain all"}
              </Button>
              <Button
                variant="primary"
                onClick={() => fileInputRef.current?.click()}
                loading={uploading}
                icon={<Upload className="w-4 h-4" />}
              >
                Upload
              </Button>
            </>
          }
        />

        {templates.length > 0 && (
          <Toolbar>
            <SearchInput
              label="Search templates"
              placeholder="Name, category or keyword…"
              value={searchTerm}
              onChange={setSearchTerm}
            />
            <div className="ml-auto flex items-center gap-2">
              {lastTrained && (
                <span className="text-[length:var(--text-xs)] text-[var(--text-muted)]">
                  Last trained {lastTrained}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-[var(--danger-strong)]"
                onClick={() => setShowDeleteAllModal(true)}
                disabled={isTraining}
                icon={<Trash2 className="w-3.5 h-3.5" />}
              >
                Delete all
              </Button>
            </div>
          </Toolbar>
        )}

        <PageBody className="space-y-4">
          {trainingStale && (
            <Notice tone="warn" title="Training is out of date">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span>
                  Templates or companies have changed since the last run. The agent is still answering from the old
                  training data.
                </span>
                <Button size="sm" onClick={() => startTraining(true)}>
                  Retrain now
                </Button>
              </div>
            </Notice>
          )}

          {error && <Notice tone="danger" title="Could not load templates">{error}</Notice>}

          {templates.length === 0 ? (
            <EmptyState
              icon={<FileText className="w-4 h-4" />}
              title="No templates yet"
              description="A template is a Word document with placeholders the agent fills from company data."
              steps={[
                { title: "Upload a .docx", body: "Placeholders can be written {{field}}, {field} or [field]." },
                { title: "Train it", body: "Sixteen stages extract the fields, classify them and teach the agent what the document is for." },
                { title: "Generate", body: "Ask the agent in chat and it produces the filled document." },
              ]}
              action={
                <Button variant="primary" onClick={() => fileInputRef.current?.click()} icon={<Upload className="w-4 h-4" />}>
                  Upload the first template
                </Button>
              }
            />
          ) : (
            <>
              <StatRow>
                <StatTile label="Templates" value={stats.total} />
                <StatTile label="Trained" value={stats.trained} tone={stats.trained > 0 ? "ok" : undefined} />
                <StatTile
                  label="Untrained"
                  value={stats.untrained}
                  tone={stats.untrained > 0 ? "warn" : undefined}
                  hint={stats.untrained > 0 ? "Agent cannot use these yet" : "Everything is trained"}
                />
                <StatTile
                  label="Average confidence"
                  value={stats.avg ? `${stats.avg}%` : "—"}
                  tone={stats.lowConfidence > 0 ? "warn" : undefined}
                  hint={stats.lowConfidence > 0 ? `${stats.lowConfidence} below 50%` : undefined}
                />
              </StatRow>

              <DataTable
                rows={filtered}
                columns={columns}
                rowKey={(t) => t.name}
                onRowClick={setSelectedTemplate}
                caption="Templates"
                rowTone={(t) => (isTrained(t) ? null : "var(--warn)")}
                empty={
                  <div className="py-2">
                    <p className="text-[length:var(--text-sm)] text-[var(--text)]">
                      No match for &ldquo;{searchTerm}&rdquo;
                    </p>
                    <Button size="sm" className="mt-3" onClick={() => setSearchTerm("")}>
                      Clear search
                    </Button>
                  </div>
                }
              />
            </>
          )}
        </PageBody>
      </Page>

      {trainingModal}

      {/* Duplicate upload */}
      <Modal
        open={!!duplicateError}
        onOpenChange={(o) => !o && setDuplicateError(null)}
        size="sm"
        title="That template already exists"
        description="Templates are keyed by file name, so this one was not uploaded."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDuplicateError(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const name = duplicateError?.name
                setDuplicateError(null)
                const t = templates.find((x) => x.name === name)
                if (t) deleteTemplate(t)
              }}
            >
              Delete the existing one
            </Button>
          </>
        }
      >
        {duplicateError && (
          <DetailList
            columns={1}
            items={[
              ["File name", duplicateError.name],
              ["Category", duplicateError.existing?.category || "—"],
              ["Placeholders", duplicateError.existing?.fields ?? "—"],
              [
                "Status",
                duplicateError.existing?.trained ? (
                  <Badge tone="ok" dot>
                    Trained
                  </Badge>
                ) : (
                  <Badge tone="warn" dot>
                    Untrained
                  </Badge>
                ),
              ],
              ["Uploaded", formatDateTime(duplicateError.existing?.uploaded_at)],
            ]}
          />
        )}
      </Modal>

      {/* Delete all — typed confirmation */}
      <Modal
        open={showDeleteAllModal}
        onOpenChange={(o) => {
          if (!o) {
            setShowDeleteAllModal(false)
            setDeleteAllConfirm("")
          }
        }}
        size="sm"
        title="Delete every template"
        description={`This removes all ${templates.length} templates and their training data. It cannot be undone.`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setShowDeleteAllModal(false)
                setDeleteAllConfirm("")
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={deleteAllTemplates}
              loading={deletingAll}
              disabled={deleteAllConfirm !== "DELETE ALL"}
            >
              Delete all templates
            </Button>
          </>
        }
      >
        <Notice tone="danger" title="Destructive">
          Generated documents keep working, but the agent will have no templates to fill until you upload and train
          again.
        </Notice>
        <p className="mt-3 mb-1.5 text-[length:var(--text-sm)] text-[var(--text)]">
          Type <span className="font-mono font-semibold">DELETE ALL</span> to confirm.
        </p>
        <Input
          value={deleteAllConfirm}
          onChange={(e) => setDeleteAllConfirm(e.target.value)}
          placeholder="DELETE ALL"
          aria-label="Type DELETE ALL to confirm"
        />
      </Modal>
    </>
  )
}
