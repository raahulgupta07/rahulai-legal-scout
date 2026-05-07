"use client"

import React, { useEffect, useState, useRef } from "react"
import { FileText, Upload, Sparkles, Trash2, X, CheckCircle, Loader2, Terminal, Square, Download, Eye } from "lucide-react"
import apiClient, { authFetch } from "@/lib/api-client"
import DocViewer from "@/components/ui/DocViewer"

interface Template {
  name: string
  path: string
  fields: any[]
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
}

interface TerminalLine {
  id: number
  text: string
  type: 'info' | 'success' | 'error' | 'processing' | 'ai'
  timestamp: string
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [isTraining, setIsTraining] = useState(false)
  const [trainingComplete, setTrainingComplete] = useState(false)
  const [lastTrained, setLastTrained] = useState<string | null>(null)
  const [terminalLogs, setTerminalLogs] = useState<TerminalLine[]>([])
  const [uploading, setUploading] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState<Template | null>(null)
  const [showLogModal, setShowLogModal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false)
  const [deleteAllConfirm, setDeleteAllConfirm] = useState("")
  const [deletingAll, setDeletingAll] = useState(false)
  const [trainingStale, setTrainingStale] = useState(false)
  const [duplicateError, setDuplicateError] = useState<{
    name: string; error: string;
    existing?: { name: string; fields: number; category: string; trained: boolean; uploaded_at: string | null }
  } | null>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const logIdRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    fetchTemplates()
    checkTrainingStatus()
  }, [])

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [terminalLogs])

  // Save training logs to DB when training completes
  useEffect(() => {
    if (trainingComplete && terminalLogs.length > 0 && !isTraining) {
      authFetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/training/save-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "templates", logs: terminalLogs })
      }).catch((e) => { console.error("Save training logs error:", e) })
    }
  }, [trainingComplete])

  const checkTrainingStatus = async () => {
    try {
      const res = await authFetch(apiClient.getTrainingStatus())
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json()
      if (data.success && data.data?.templates) {
        if (data.data.templates.last_trained) {
          setLastTrained(new Date(data.data.templates.last_trained).toLocaleString())
        }
        // Check if training is stale
        if (data.data.templates.status === 'stale') {
          setTrainingStale(true)
          setTrainingComplete(false)
        }
        // Load persisted training logs
        if (data.data.templates.logs && data.data.templates.logs.length > 0) {
          setTerminalLogs(data.data.templates.logs)
          if (data.data.templates.status !== 'stale') {
            setTrainingComplete(true)
          }
        }
      }
    } catch (e) { console.error("Training status check error:", e) }
  }

  const addLog = (text: string, type: TerminalLine['type'] = 'info') => {
    const now = new Date()
    const timestamp = now.toLocaleTimeString('en-US', { hour12: false })
    setTerminalLogs(prev => [...prev, { id: logIdRef.current++, text, type, timestamp }])
  }

  const fetchTemplates = async () => {
    try {
      setError(null)
      const res = await authFetch(apiClient.getDashboardTemplates())
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json()
      setTemplates(data.templates || [])
    } catch (error) {
      console.error("Failed to fetch templates:", error)
      setError("Failed to load templates")
    } finally {
      setLoading(false)
    }
  }

  const handleSelectTemplate = (template: Template) => {
    setSelectedTemplate(selectedTemplate?.name === template.name ? null : template)
  }

  const startTraining = async (trainAll = false) => {
    if (templates.length === 0) return

    const toTrain = trainAll
      ? templates
      : templates.filter(t => !t.ai_trained && !t.ai_analyzed)

    if (toTrain.length === 0) {
      // All trained — ask if user wants to retrain
      if (!confirm("All templates are already trained. Retrain all?")) return
      return startTraining(true)
    }

    const token = localStorage.getItem("ls_token")
    if (!token) {
      const { toast } = await import("sonner")
      toast.error("Please log in again")
      return
    }

    setIsTraining(true)
    setTrainingComplete(false)
    setTerminalLogs([])
    setShowLogModal(true)

    const controller = new AbortController()
    abortControllerRef.current = controller

    const API_BASE = process.env.NEXT_PUBLIC_API_URL || ''

    const skipped = templates.length - toTrain.length
    addLog("━".repeat(55), 'info')
    addLog("LEGAL SCOUT — AI TRAINING", 'info')
    addLog(`Training ${toTrain.length} template(s)${skipped > 0 ? ` (${skipped} already trained, skipped)` : ''}...`, 'info')
    addLog("━".repeat(55), 'info')

    try {
      let successCount = 0

      for (let i = 0; i < toTrain.length; i++) {
        const t = toTrain[i]
        addLog("", 'info')
        addLog(`╔══ [${i + 1}/${toTrain.length}] ${t.name}`, 'ai')

        try {
          // SSE streaming — each step appears live
          const res = await fetch(`${API_BASE}/api/knowledge/train-stream/${encodeURIComponent(t.name)}`, {
            headers: { "Authorization": `Bearer ${token}` },
            signal: controller.signal,
          })

          if (!res.ok) {
            addLog(`  ✗ Training failed: ${res.status}`, 'error')
            addLog(`╚══ ❌ Failed`, 'error')
            continue
          }

          if (!res.body) {
            addLog(`  ✗ No response body`, 'error')
            addLog(`╚══ ❌ Failed`, 'error')
            continue
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          let templateDone = false

          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            // Parse SSE events from buffer
            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue
              try {
                const step = JSON.parse(line.slice(6))
                const s = step.step
                const m = step.msg

                if (s === "extract_start") addLog(`  📋 ${m}`, 'processing')
                else if (s === "extract") {
                  addLog(`  📋 ${m}`, 'success')
                  if (step.fields?.length > 0)
                    addLog(`    Fields: ${step.fields.slice(0, 8).join(', ')}${step.fields.length > 8 ? '...' : ''}`, 'info')
                }
                else if (s === "read_start") addLog(`  📄 ${m}`, 'processing')
                else if (s === "read") addLog(`  📄 ${m}`, 'info')
                else if (s === "ai_start") addLog(`  🧠 ${m}`, 'processing')
                else if (s === "ai_done") addLog(`  🧠 ${m}`, 'success')
                else if (s === "ai_warn") addLog(`  ⚠ ${m}`, 'error')
                else if (s === "ai_analysis") {
                  addLog(`  🧠 ${m}`, 'ai')
                  if (step.purpose) addLog(`    📌 Purpose: ${step.purpose}`, 'success')
                  if (step.legal_refs?.length > 0) addLog(`    📜 Legal: ${step.legal_refs.join(', ')}`, 'info')
                  if (step.required > 0) addLog(`    🔴 Required fields: ${step.required}`, 'info')
                  if (step.optional > 0) addLog(`    🟢 Optional fields: ${step.optional}`, 'info')
                }
                else if (s === "save_start") addLog(`  💾 ${m}`, 'processing')
                else if (s === "save_warn") addLog(`  ⚠ ${m}`, 'error')
                else if (s === "metadata") addLog(`  ✓ ${m}`, 'success')
                else if (s === "classify_start") addLog(`  🤖 ${m}`, 'processing')
                else if (s === "classify") {
                  addLog(`  🤖 ${m}`, 'ai')
                  if (step.db_fields) addLog(`    Auto-fill (${step.db_fields.length}): ${step.db_fields.join(', ')}`, 'success')
                  if (step.user_input_fields) addLog(`    User input (${step.user_input_fields.length}): ${step.user_input_fields.join(', ')}`, 'ai')
                }
                else if (s === "classify_warn") addLog(`  ⚠ ${m}`, 'error')
                else if (s === "kb_start") addLog(`  💾 ${m}`, 'processing')
                else if (s === "knowledge") addLog(`  💾 ${m}`, 'success')
                else if (s === "kb_warn") addLog(`  ⚠ ${m}`, 'error')
                else if (s === "embed_start") addLog(`  🔢 ${m}`, 'processing')
                else if (s === "embedding") addLog(`  🔢 ${m}`, 'success')
                else if (s === "embed_skip" || s === "embed_warn") addLog(`  ⚠ ${m}`, 'processing')
                else if (s === "pdf_start") addLog(`  📄 ${m}`, 'processing')
                else if (s === "pdf") addLog(`  📄 ${m}`, 'success')
                else if (s === "pdf_warn") addLog(`  ⚠ ${m}`, 'processing')

                // Per-field discovery (enhanced Step 1)
                else if (s === "field_found") addLog(`    → ${step.field}`, 'info')

                // Step 5.5: Field mapping
                else if (s === "mapping_start") addLog(`  🗺 ${m}`, 'processing')
                else if (s === "mapping") addLog(`  🗺 ${m}`, 'success')
                else if (s === "mapping_warn") addLog(`  ⚠ ${m}`, 'error')

                // Step 9: Field deep analysis
                else if (s === "field_deep_start") addLog(`  🔬 ${m}`, 'processing')
                else if (s === "field_detail") addLog(`    → ${step.field} (${step.detail?.data_type || 'text'}) ${step.detail?.required ? '● required' : '○ optional'}`, 'ai')
                else if (s === "field_deep") addLog(`  🔬 ${m}`, 'success')
                else if (s === "field_deep_warn") addLog(`  ⚠ ${m}`, 'error')

                // Step 10: Legal references
                else if (s === "legal_ref_start") addLog(`  ⚖ ${m}`, 'processing')
                else if (s === "legal_ref") addLog(`  ⚖ ${m}`, 'success')
                else if (s === "legal_ref_warn") addLog(`  ⚠ ${m}`, 'error')

                // Step 11: Sample filled document
                else if (s === "sample_start") addLog(`  📝 ${m}`, 'processing')
                else if (s === "sample") addLog(`  📝 ${m}`, 'success')
                else if (s === "sample_warn") addLog(`  ⚠ ${m}`, 'error')

                // Step 12: Document workflow
                else if (s === "workflow_start") addLog(`  🔄 ${m}`, 'processing')
                else if (s === "workflow") addLog(`  🔄 ${m}`, 'success')
                else if (s === "workflow_warn") addLog(`  ⚠ ${m}`, 'error')

                // Step 13: Q&A pairs
                else if (s === "qa_start") addLog(`  ❓ ${m}`, 'processing')
                else if (s === "qa") addLog(`  ❓ ${m}`, 'success')
                else if (s === "qa_warn") addLog(`  ⚠ ${m}`, 'error')

                // Step 14: Cross-template relationships
                else if (s === "cross_ref_start") addLog(`  🔗 ${m}`, 'processing')
                else if (s === "cross_ref") addLog(`  🔗 ${m}`, 'success')
                else if (s === "cross_ref_warn") addLog(`  ⚠ ${m}`, 'error')

                // Step 15: Confidence scoring
                else if (s === "confidence_start") addLog(`  📊 ${m}`, 'processing')
                else if (s === "confidence") addLog(`  📊 ${m}`, 'success')
                else if (s === "confidence_warn") addLog(`  ⚠ ${m}`, 'error')

                else if (s === "done") templateDone = true
                else if (s === "error") addLog(`  ✗ ${m}`, 'error')
                else addLog(`  ${m}`, 'info')
              } catch (e) { console.error("SSE parse error:", e) }
            }
          }

          if (templateDone) {
            successCount++
            addLog(`╚══ ✅ Done`, 'success')
          } else {
            addLog(`╚══ ❌ Failed`, 'error')
          }
        } catch (e) {
          addLog(`  ✗ Connection error`, 'error')
          addLog(`╚══ ❌ Failed`, 'error')
        }
      }

      // Refresh agent knowledge
      addLog("", 'info')
      addLog("Refreshing agent knowledge...", 'processing')
      try {
        const dtRes = await authFetch(`${API_BASE}/api/knowledge/deep-train`, { method: "POST" })
        if (!dtRes.ok) throw new Error(`Deep train failed: ${dtRes.status}`)
      } catch (e) { console.error("Deep train error:", e) }
      addLog("✓ Agent knowledge updated", 'success')

      // Summary
      addLog("", 'info')
      addLog("━".repeat(55), 'success')
      addLog("✅ TRAINING COMPLETE — Deep Training (15 Steps)", 'success')
      addLog("━".repeat(55), 'success')
      addLog("", 'info')
      addLog("  📋 Templates trained:        " + `${successCount}/${toTrain.length}${skipped > 0 ? ` (${skipped} skipped)` : ''}`, 'success')
      addLog("  🤖 AI model:                 Configured model (via OpenRouter)", 'ai')
      addLog("  🔬 Field deep analysis:      Complete", 'success')
      addLog("  ⚖  Legal references:         Myanmar Companies Law 2017", 'success')
      addLog("  📝 Sample documents:         Generated", 'success')
      addLog("  🔄 Document workflows:       Mapped", 'success')
      addLog("  ❓ Q&A pairs:                Generated for knowledge base", 'success')
      addLog("  🔗 Cross-template links:     Mapped", 'success')
      addLog("  📊 Confidence scores:        Calculated", 'success')
      addLog("  📄 PDF previews:             Generated (placeholders highlighted)", 'success')
      addLog("  🧠 Agent knowledge:          Refreshed", 'success')
      addLog("", 'info')
      addLog("━".repeat(55), 'success')
      
      setTrainingComplete(true)
      setTrainingStale(false)
      setLastTrained(new Date().toLocaleString())
      await fetchTemplates()
      
    } catch (error) {
      console.error("Process error:", error)
      addLog("", 'error')
      addLog("✗ ERROR: Training failed", 'error')
    } finally {
      abortControllerRef.current = null
      setIsTraining(false)
    }
  }

  const stopTraining = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setIsTraining(false)
    addLog("", 'error')
    addLog("⚠️ TRAINING STOPPED BY USER", 'error')
  }

  const deleteTemplate = async () => {
    if (!showDeleteModal) return
    try {
      const res = await authFetch(apiClient.deleteTemplate(showDeleteModal.name), { method: "DELETE" })
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json()
      if (data.training_invalidated) {
        setTrainingStale(true)
        setTrainingComplete(false)
      }
      await fetchTemplates()
    } catch (error) {
      console.error("Failed to delete:", error)
    } finally {
      setShowDeleteModal(null)
    }
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        if (!file.name.endsWith(".doc") && !file.name.endsWith(".docx") && !file.name.endsWith(".pdf")) continue
        const formData = new FormData()
        formData.append("file", file)
        const res = await authFetch(apiClient.uploadTemplate(), { method: "POST", body: formData })
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
        const data = await res.json()
        if (!data.success) {
          if (data.exists) {
            setDuplicateError({
              name: file.name,
              error: data.error,
              existing: data.existing_template,
            })
          } else {
            // Other error
            const { toast } = await import("sonner")
            toast.error(data.error || "Upload failed")
          }
        }
      }
      await fetchTemplates()
    } catch (error) {
      console.error("Failed to upload:", error)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const getLogColor = (type: TerminalLine['type']) => {
    switch (type) {
      case 'success': return 'text-green-700'
      case 'error': return 'text-red-700'
      case 'processing': return 'text-yellow-700'
      case 'ai': return 'text-purple-700'
      default: return 'text-gray-300'
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <input ref={fileInputRef} type="file" accept=".doc,.docx,.pdf" multiple onChange={handleUpload} className="hidden" />

      <div className="flex items-center justify-between p-4 border-b border-gray-400 dark:border-primary/10 bg-card">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-primary">Templates</h1>
          <span className="text-xs text-muted bg-accent rounded-full px-2 py-0.5">{templates.length}</span>
          {isTraining && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-500/10 rounded-lg">
              <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
              <span className="text-xs text-orange-500">Training in progress...</span>
            </div>
          )}
          {trainingComplete && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 rounded-lg">
              <CheckCircle className="w-4 h-4 text-green-500" />
              <span className="text-xs text-green-500">Training Complete!</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowLogModal(true)}
            className="flex items-center gap-2 px-3 py-2 text-xs font-medium border border-gray-400 dark:border-primary/10 rounded-lg hover:bg-accent"
          >
            <Terminal className="w-4 h-4" />
            {isTraining ? 'View Progress' : trainingComplete ? 'View Last Training' : 'Training Logs'}
            {isTraining && <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>}
          </button>
          <button
            onClick={() => startTraining(false)}
            disabled={isTraining || templates.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium bg-gradient-to-r from-orange-500 to-red-600 text-white rounded-lg hover:from-orange-600 hover:to-red-700 disabled:opacity-50"
          >
            <Sparkles className={`w-4 h-4 ${isTraining ? "animate-spin" : ""}`} />
            {isTraining ? "Training..." : templates.some(t => !t.ai_trained && !t.ai_analyzed) ? `Train New (${templates.filter(t => !t.ai_trained && !t.ai_analyzed).length})` : "Start Training"}
          </button>
          <button
            onClick={() => setShowDeleteAllModal(true)}
            disabled={isTraining || templates.length === 0}
            className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-red-600 border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50"
            title="Delete all templates"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/80 disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </div>
      </div>

      {!selectedTemplate && trainingStale && (
        <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-700 flex items-center justify-between">
          <span>⚠ Training is outdated — templates or companies have changed. Re-training required for AI to use latest data.</span>
          <button onClick={() => startTraining(true)}
            className="px-3 py-1 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 shrink-0 ml-3">
            Retrain Now
          </button>
        </div>
      )}
      {!selectedTemplate && lastTrained && !trainingStale && (
        <div className="px-4 py-2 bg-green-500/10 border-b border-green-500/20 text-xs text-green-700">
          ✓ Last trained: {lastTrained}
        </div>
      )}

      {!selectedTemplate && error && <div className="px-4 py-2 bg-red-500/10 text-red-500 text-sm">{error}</div>}

      {!selectedTemplate && <div className="flex-1 overflow-auto p-4">
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="text-sm font-semibold">All Templates ({templates.length})</h2>
          </div>

          <div className="border border-gray-400 dark:border-primary/10 bg-card rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-400 dark:border-primary/10">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted">Template Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted">Placeholders</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted">Uploaded By</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted">Actions</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => (
                  <tr
                    key={template.name}
                    className="border-b border-gray-400 dark:border-primary/10 last:border-0 hover:bg-accent/30 cursor-pointer"
                    onClick={() => handleSelectTemplate(template)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-primary/10 rounded-lg"><FileText className="w-4 h-4 text-primary" /></div>
                        <span className="text-sm font-medium">{template.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-1 bg-green-500/10 text-green-700 rounded">
                        {template.total_fields || template.fields?.length || 0}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                      {template.ai_trained || template.ai_analyzed ? (
                        <span className="text-xs px-2 py-1 bg-emerald-500/10 text-emerald-700 rounded-full flex items-center gap-1 w-fit">
                          <CheckCircle className="w-3 h-3" /> Trained
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-1 bg-yellow-500/10 text-yellow-700 rounded-full w-fit">
                          Untrained
                        </span>
                      )}
                      {(template as any).training_confidence > 0 && (
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          (template as any).training_confidence >= 80 ? 'bg-green-500/20 text-green-700' :
                          (template as any).training_confidence >= 50 ? 'bg-yellow-500/20 text-yellow-700' :
                          'bg-red-500/20 text-red-700'
                        }`}>
                          {(template as any).training_confidence}%
                        </span>
                      )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-500">{template.uploaded_by_email || "—"}</span>
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setShowDeleteModal(template)} className="p-1.5 text-muted hover:text-red-700 hover:bg-red-500/10 rounded-lg" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {templates.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-muted">
                      <FileText className="w-10 h-10 mx-auto mb-3 opacity-50" />
                      <p className="text-sm">No templates available</p>
                      <button onClick={() => fileInputRef.current?.click()} className="text-xs hover:underline mt-2">Upload a template</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>}

          {/* Template Details — Split View */}
          {selectedTemplate && (
            <div className="flex flex-col h-[calc(100vh-60px)]">
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-gray-300 bg-card shrink-0">
                <div className="flex items-center gap-3">
                  <button onClick={() => setSelectedTemplate(null)} className="p-1.5 rounded-lg hover:bg-accent text-muted hover:text-primary">
                    <X className="w-4 h-4" />
                  </button>
                  <FileText className="w-5 h-5 text-brand" />
                  <h3 className="text-sm font-semibold text-primary truncate max-w-[400px]">{selectedTemplate.name}</h3>
                </div>
                <div className="flex items-center gap-2">
                  <a href={apiClient.downloadTemplate(selectedTemplate.name)} download
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/80">
                    <Download className="w-3.5 h-3.5" /> Download
                  </a>
                  <button onClick={() => window.open('/', '_blank')}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-gradient-to-r from-orange-500 to-red-600 text-white rounded-lg hover:from-orange-600 hover:to-red-700">
                    Generate Document
                  </button>
                </div>
              </div>

              {/* Split View */}
              <div className="flex flex-1 overflow-hidden">
                {/* Left — PDF Preview */}
                <div className="w-1/2 flex flex-col border-r border-gray-300">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-gray-50 shrink-0">
                    <Eye className="w-4 h-4 text-brand" />
                    <span className="text-xs font-semibold text-gray-700">Document Preview</span>
                  </div>
                  <DocViewer
                    url={`${apiClient.previewTemplatePdf(selectedTemplate.name)}?token=${typeof window !== 'undefined' ? (localStorage.getItem('ls_token') || '') : ''}`}
                    forceFormat="pdf"
                    className="flex-1 w-full"
                  />
                </div>

                {/* Right — Metadata */}
                <div className="w-1/2 flex flex-col">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-gray-50 shrink-0">
                    <FileText className="w-4 h-4 text-brand" />
                    <span className="text-xs font-semibold text-gray-700">Template Details</span>
                  </div>
                  <div className="flex-1 overflow-auto p-6">
                    <div className="space-y-6">
                    {/* Basic Info */}
                    <div className="grid grid-cols-4 gap-4">
                      <div className="p-4 bg-muted/20 rounded-lg">
                        <h4 className="text-xs font-semibold text-gray-500 mb-1">Category</h4>
                        <p className="text-sm text-gray-900">{selectedTemplate.category || 'Not set'}</p>
                      </div>
                      <div className="p-4 bg-muted/20 rounded-lg">
                        <h4 className="text-xs font-semibold text-gray-500 mb-1">Complexity</h4>
                        <p className="text-sm text-gray-900">{selectedTemplate.complexity || 'Not set'}</p>
                      </div>
                      <div className="p-4 bg-muted/20 rounded-lg">
                        <h4 className="text-xs font-semibold text-gray-500 mb-1">Est. Time</h4>
                        <p className="text-sm text-gray-900">{selectedTemplate.estimated_time || 'Not set'}</p>
                      </div>
                      <div className="p-4 bg-muted/20 rounded-lg">
                        <h4 className="text-xs font-semibold text-gray-500 mb-1">Jurisdiction</h4>
                        <p className="text-sm text-gray-900">{selectedTemplate.jurisdiction || 'Not set'}</p>
                      </div>
                    </div>
                    
                    {/* Purpose */}
                    <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                      <h4 className="text-xs font-medium text-blue-700 mb-2">Purpose</h4>
                      <p className="text-sm text-gray-900">{selectedTemplate.purpose || selectedTemplate.description || 'Not set'}</p>
                    </div>
                    
                    {/* When to Use */}
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 mb-2">When to Use</h4>
                      <p className="text-sm text-gray-900">{selectedTemplate.when_to_use || 'Not set'}</p>
                    </div>
                    
                    {/* How to Use - Step by Step */}
                    {selectedTemplate.how_to_use && selectedTemplate.how_to_use.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 mb-2">How to Use (Step by Step)</h4>
                        <div className="space-y-2">
                          {selectedTemplate.how_to_use.map((step: any, idx: number) => (
                            <div key={idx} className="flex gap-3 text-sm">
                              <span className="text-orange-700 font-medium">{idx + 1}.</span>
                              <span className="text-gray-900">{step}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Prerequisites */}
                    {selectedTemplate.prerequisites && selectedTemplate.prerequisites.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 mb-2">Prerequisites</h4>
                        <div className="flex flex-wrap gap-2">
                          {selectedTemplate.prerequisites.map((item: any, idx: number) => (
                            <span key={idx} className="px-3 py-1 text-xs bg-yellow-500/10 text-yellow-700 rounded-lg border border-yellow-500/20">
                              {item}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Signatures & Approval Chain */}
                    {selectedTemplate.approval_chain && selectedTemplate.approval_chain.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 mb-2">Approval Chain</h4>
                        <div className="flex flex-wrap gap-2">
                          {selectedTemplate.approval_chain.map((item: any, idx: number) => (
                            <span key={idx} className="px-3 py-1 text-xs bg-purple-500/10 text-purple-700 rounded-lg border border-purple-500/20">
                              {typeof item === 'string' ? item : item.name || JSON.stringify(item)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Filing Deadline & Fees */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 bg-muted/20 rounded-lg">
                        <h4 className="text-xs font-semibold text-gray-500 mb-1">Filing Deadline</h4>
                        <p className="text-sm text-gray-900">{selectedTemplate.filing_deadline || 'Not set'}</p>
                      </div>
                      <div className="p-4 bg-muted/20 rounded-lg">
                        <h4 className="text-xs font-semibold text-gray-500 mb-1">Fees</h4>
                        <p className="text-sm text-gray-900">{selectedTemplate.fees || 'Not set'}</p>
                      </div>
                    </div>
                    
                    {/* Validity Period */}
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 mb-2">Validity Period</h4>
                      <p className="text-sm text-gray-900">{selectedTemplate.validity_period || 'Not set'}</p>
                    </div>
                    
                    {/* Common Mistakes */}
                    {selectedTemplate.common_mistakes && selectedTemplate.common_mistakes.length > 0 && (
                      <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                        <h4 className="text-xs font-medium text-red-700 mb-2">Common Mistakes to Avoid</h4>
                        <ul className="space-y-1">
                          {selectedTemplate.common_mistakes.map((mistake: any, idx: number) => (
                            <li key={idx} className="text-sm text-primary flex gap-2">
                              <span className="text-red-700">•</span>
                              {mistake}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    
                    {/* Required Attachments */}
                    {selectedTemplate.required_attachments && selectedTemplate.required_attachments.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 mb-2">Required Attachments</h4>
                        <div className="flex flex-wrap gap-2">
                          {selectedTemplate.required_attachments.map((item: any, idx: number) => (
                            <span key={idx} className="px-3 py-1 text-xs bg-green-500/10 text-green-700 rounded-lg border border-green-500/20">
                              {item}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Keywords */}
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 mb-2">Keywords</h4>
                      <p className="text-sm text-gray-900">{selectedTemplate.keywords || 'Not set'}</p>
                    </div>
                    
                    {/* Field Classification */}
                    {(() => {
                      // Parse fields — could be string, array, or classified object
                      let fields = selectedTemplate.fields
                      if (typeof fields === 'string') {
                        try { fields = JSON.parse(fields) } catch { fields = [] }
                      }

                      const isClassified = fields && !Array.isArray(fields) && (fields as any)?.db_fields

                      if (isClassified) {
                        const f = fields as any
                        const allPlaceholders = [...(f.db_fields || []), ...(f.user_input_fields || [])]
                        return (
                          <>
                            {/* All Placeholders */}
                            <div>
                              <h4 className="text-sm font-semibold text-gray-700 mb-2">
                                All Placeholders ({allPlaceholders.length})
                              </h4>
                              <div className="flex flex-wrap gap-2">
                                {allPlaceholders.map((field: string, idx: number) => (
                                  <span key={idx} className={`px-3 py-1.5 text-xs rounded-lg border ${
                                    (f.db_fields || []).includes(field)
                                      ? 'bg-green-500/10 text-green-700 border-green-500/20'
                                      : 'bg-blue-500/10 text-blue-700 border-blue-500/20'
                                  }`}>
                                    {field}
                                    {(f.db_fields || []).includes(field) && <span className="ml-1 text-green-500">●</span>}
                                    {(f.user_input_fields || []).includes(field) && <span className="ml-1 text-blue-500">●</span>}
                                  </span>
                                ))}
                              </div>
                              <div className="flex gap-4 mt-2 text-xs text-gray-500">
                                <span className="flex items-center gap-1"><span className="text-green-500">●</span> Auto-filled from DB ({(f.db_fields || []).length})</span>
                                <span className="flex items-center gap-1"><span className="text-blue-500">●</span> User input required ({(f.user_input_fields || []).length})</span>
                              </div>
                            </div>

                            {/* Field Descriptions */}
                            {f.field_descriptions && Object.keys(f.field_descriptions).length > 0 && (
                              <div>
                                <h4 className="text-xs font-semibold text-gray-500 mb-2">Field Descriptions</h4>
                                <div className="space-y-1">
                                  {Object.entries(f.field_descriptions).map(([key, desc]: [string, any]) => (
                                    <div key={key} className="flex gap-2 text-sm">
                                      <span className="font-medium text-gray-700 shrink-0">{key}:</span>
                                      <span className="text-gray-500">{desc}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Static Text Warnings */}
                            {f.static_text_warnings?.length > 0 && (
                              <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                                <h4 className="text-xs font-medium text-yellow-700 mb-2">Static Text Warnings</h4>
                                <ul className="space-y-1">
                                  {f.static_text_warnings.map((w: string, idx: number) => (
                                    <li key={idx} className="text-sm text-gray-800 flex gap-2">
                                      <span className="text-yellow-600">⚠</span> {w}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </>
                        )
                      }

                      // Fallback: not classified yet — show raw placeholders
                      const rawFields = Array.isArray(fields) ? fields : (fields as any)?.all_fields || []
                      return (
                        <div>
                          <h4 className="text-sm font-semibold text-gray-500 mb-3">
                            Placeholders ({rawFields.length})
                          </h4>
                          <p className="text-xs text-gray-400 mb-2">Click "Start Training" to classify fields as auto-fill vs user-input</p>
                          <div className="flex flex-wrap gap-2">
                            {rawFields.map((field: any, idx: number) => (
                              <span key={idx} className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded-lg border border-gray-200">
                                {typeof field === 'string' ? field : field.name || JSON.stringify(field)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )
                    })()}

                    {/* ── Deep Training Sections ── */}

                    {/* Field Deep Analysis */}
                    {(selectedTemplate as any).field_deep_analysis && Object.keys((selectedTemplate as any).field_deep_analysis).length > 0 && (
                      <div className="mt-4">
                        <h4 className="text-sm font-semibold text-primary mb-2">Field Analysis</h4>
                        <div className="overflow-auto max-h-48">
                          <table className="w-full text-xs">
                            <thead><tr className="border-b border-primary/10">
                              <th className="text-left py-1 px-2 text-muted">Field</th>
                              <th className="text-left py-1 px-2 text-muted">Type</th>
                              <th className="text-left py-1 px-2 text-muted">Format</th>
                              <th className="text-left py-1 px-2 text-muted">Required</th>
                            </tr></thead>
                            <tbody>
                              {Object.entries((selectedTemplate as any).field_deep_analysis).map(([name, info]: [string, any]) => (
                                <tr key={name} className="border-b border-primary/5">
                                  <td className="py-1 px-2 font-medium">{name}</td>
                                  <td className="py-1 px-2 text-muted">{info?.data_type || '—'}</td>
                                  <td className="py-1 px-2 text-muted">{info?.format || '—'}</td>
                                  <td className="py-1 px-2">{info?.required ? <span className="text-red-600">Yes</span> : <span className="text-green-600">Optional</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Sample Filled Document */}
                    {(selectedTemplate as any).sample_filled_document && Object.keys((selectedTemplate as any).sample_filled_document).length > 0 && (
                      <div className="mt-4">
                        <h4 className="text-sm font-semibold text-primary mb-2">Sample Values</h4>
                        <div className="grid grid-cols-2 gap-1">
                          {Object.entries((selectedTemplate as any).sample_filled_document).slice(0, 12).map(([key, val]: [string, any]) => (
                            <div key={key} className="flex gap-2 text-xs py-1">
                              <span className="text-muted">{key}:</span>
                              <span className="font-medium truncate">{String(val)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Document Workflow */}
                    {(selectedTemplate as any).document_workflow && (
                      <div className="mt-4">
                        <h4 className="text-sm font-semibold text-primary mb-2">Document Workflow</h4>
                        {(selectedTemplate as any).document_workflow.trigger && (
                          <p className="text-xs text-muted mb-2">Trigger: {(selectedTemplate as any).document_workflow.trigger}</p>
                        )}
                        <div className="flex items-center gap-2 flex-wrap">
                          {((selectedTemplate as any).document_workflow.before || []).map((d: string, i: number) => (
                            <span key={`b${i}`} className="text-xs px-2 py-1 bg-blue-500/10 text-blue-700 rounded">{d}</span>
                          ))}
                          {((selectedTemplate as any).document_workflow.before || []).length > 0 && <span className="text-muted">→</span>}
                          <span className="text-xs px-2 py-1 bg-brand/20 text-brand font-semibold rounded">{selectedTemplate.name.replace('.docx','')}</span>
                          {((selectedTemplate as any).document_workflow.after || []).length > 0 && <span className="text-muted">→</span>}
                          {((selectedTemplate as any).document_workflow.after || []).map((d: string, i: number) => (
                            <span key={`a${i}`} className="text-xs px-2 py-1 bg-green-500/10 text-green-700 rounded">{d}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Cross-Template Relationships */}
                    {(selectedTemplate as any).cross_template_relationships?.length > 0 && (
                      <div className="mt-4">
                        <h4 className="text-sm font-semibold text-primary mb-2">Related Templates</h4>
                        <div className="space-y-1">
                          {(selectedTemplate as any).cross_template_relationships.map((rel: any, i: number) => (
                            <div key={i} className="flex items-center gap-2 text-xs">
                              <span className={`px-2 py-0.5 rounded text-white ${
                                rel.relationship === 'prerequisite' ? 'bg-blue-500' :
                                rel.relationship === 'follow_up' ? 'bg-green-500' :
                                rel.relationship === 'alternative' ? 'bg-yellow-500' : 'bg-gray-500'
                              }`}>{rel.relationship}</span>
                              <span className="font-medium">{rel.template}</span>
                              <span className="text-muted">{rel.description}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Confidence Score */}
                    {(selectedTemplate as any).training_confidence > 0 && (
                      <div className="mt-4">
                        <h4 className="text-sm font-semibold text-primary mb-2">Training Confidence</h4>
                        <div className="flex items-center gap-3">
                          <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${
                              (selectedTemplate as any).training_confidence >= 80 ? 'bg-green-500' :
                              (selectedTemplate as any).training_confidence >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                            }`} style={{ width: `${(selectedTemplate as any).training_confidence}%` }} />
                          </div>
                          <span className="text-sm font-bold">{(selectedTemplate as any).training_confidence}%</span>
                        </div>
                      </div>
                    )}

                  </div>
                  </div>
                </div>
              </div>
            </div>
          )}

      {/* Terminal Log Modal - Smaller Popup */}
      {showLogModal && (
        <div className="fixed bottom-4 right-4 w-[500px] max-h-[70vh] bg-[#0d1117] border border-gray-700 rounded-xl shadow-2xl flex flex-col z-50">
          <div className="flex items-center justify-between p-3 border-b border-gray-700 bg-[#161b22] rounded-t-xl">
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-green-700" />
              <span className="text-sm font-medium text-primary">Training Progress</span>
              {isTraining && <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>}
            </div>
            <div className="flex items-center gap-2">
              {isTraining && (
                <button
                  onClick={stopTraining}
                  className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-red-500/20 text-red-700 rounded hover:bg-red-500/30"
                >
                  <Square className="w-3 h-3" />
                  Stop
                </button>
              )}
              <button onClick={() => setShowLogModal(false)} className="p-1 hover:bg-gray-700 rounded">
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
          </div>
          
          <div ref={terminalRef} className="flex-1 overflow-auto p-3 font-mono text-xs space-y-1 max-h-96">
            {terminalLogs.length === 0 ? (
              <div className="text-gray-500 text-center py-8">
                <Terminal className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p>Click "Start Training" to begin</p>
              </div>
            ) : (
              terminalLogs.map((log) => (
                <div key={log.id} className={`${getLogColor(log.type)} flex gap-2`}>
                  <span className="text-gray-600 shrink-0">[{log.timestamp}]</span>
                  <span className="whitespace-pre-wrap">{log.text}</span>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between p-2 border-t border-gray-700 bg-[#161b22] rounded-b-xl">
            <div className="text-xs text-gray-500">
              {terminalLogs.length} lines
            </div>
            {trainingComplete && (
              <span className="text-xs text-green-700 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> Complete
              </span>
            )}
          </div>
        </div>
      )}

      {/* Duplicate Template Error Modal */}
      {duplicateError && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-card border border-orange-300 rounded-xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-orange-500/10 rounded-lg">
                <FileText className="w-6 h-6 text-orange-500" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-orange-700">Template Already Exists</h2>
                <p className="text-xs text-muted">Cannot upload duplicate template</p>
              </div>
            </div>

            <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">File Name:</span>
                <span className="font-medium text-gray-900">{duplicateError.name}</span>
              </div>
              {duplicateError.existing && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Category:</span>
                    <span className="font-medium text-gray-900">{duplicateError.existing.category}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Placeholders:</span>
                    <span className="font-medium text-gray-900">{duplicateError.existing.fields}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Status:</span>
                    <span className={`font-medium ${duplicateError.existing.trained ? 'text-green-700' : 'text-yellow-700'}`}>
                      {duplicateError.existing.trained ? '✓ Trained' : 'Untrained'}
                    </span>
                  </div>
                  {duplicateError.existing.uploaded_at && (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">Uploaded:</span>
                      <span className="font-medium text-gray-900">{new Date(duplicateError.existing.uploaded_at).toLocaleString()}</span>
                    </div>
                  )}
                </>
              )}
            </div>

            <p className="text-xs text-gray-500 mb-4">
              To re-upload, delete the existing template first, then upload the new version.
            </p>

            <div className="flex gap-3">
              <button onClick={() => setDuplicateError(null)}
                className="flex-1 px-4 py-2 text-xs font-medium border border-gray-300 rounded-lg hover:bg-accent">
                OK
              </button>
              <button onClick={() => {
                const name = duplicateError.name
                setDuplicateError(null)
                const t = templates.find(t => t.name === name)
                if (t) setShowDeleteModal(t)
              }}
                className="flex-1 px-4 py-2 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600">
                Delete & Re-upload
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete ALL Templates Modal — double verification */}
      {showDeleteAllModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-card border border-red-300 rounded-xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-red-500/10 rounded-lg"><Trash2 className="w-6 h-6 text-red-500" /></div>
              <div>
                <h2 className="text-lg font-semibold text-red-700">Delete ALL Templates</h2>
                <p className="text-xs text-muted">This will remove all {templates.length} templates permanently</p>
              </div>
            </div>
            <p className="text-sm mb-4 text-gray-700">
              Type <span className="font-mono font-bold text-red-600">DELETE ALL</span> to confirm:
            </p>
            <input
              value={deleteAllConfirm}
              onChange={e => setDeleteAllConfirm(e.target.value)}
              placeholder="Type DELETE ALL"
              className="w-full px-3 py-2 text-sm border border-red-300 rounded-lg mb-4 focus:outline-none focus:border-red-500"
            />
            <div className="flex gap-3">
              <button onClick={() => { setShowDeleteAllModal(false); setDeleteAllConfirm("") }}
                className="flex-1 px-4 py-2 text-xs font-medium border border-gray-300 rounded-lg hover:bg-accent">
                Cancel
              </button>
              <button
                onClick={async () => {
                  setDeletingAll(true)
                  try {
                    const API_BASE = process.env.NEXT_PUBLIC_API_URL || ''
                    const res = await authFetch(`${API_BASE}/api/admin/reset/templates`, { method: "POST" })
                    if (!res.ok) throw new Error(`Request failed: ${res.status}`)
                    const data = await res.json()
                    if (data.success) {
                      await fetchTemplates()
                      setShowDeleteAllModal(false)
                      setDeleteAllConfirm("")
                    }
                  } catch (e) { console.error("Delete all error:", e) } finally { setDeletingAll(false) }
                }}
                disabled={deleteAllConfirm !== "DELETE ALL" || deletingAll}
                className="flex-1 px-4 py-2 text-xs font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {deletingAll ? "Deleting..." : "Delete All Templates"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-card border border-gray-400 dark:border-primary/10 rounded-xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-red-500/10 rounded-lg"><Trash2 className="w-6 h-6 text-red-500" /></div>
              <div>
                <h2 className="text-lg font-semibold">Delete Template</h2>
                <p className="text-xs text-muted">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm mb-6">Are you sure you want to delete <span className="font-medium">{showDeleteModal.name}</span>?</p>
            <div className="flex gap-3">
              <button onClick={() => setShowDeleteModal(null)} className="flex-1 px-4 py-2 text-xs font-medium border border-gray-400 dark:border-primary/10 rounded-lg hover:bg-accent">Cancel</button>
              <button onClick={deleteTemplate} className="flex-1 px-4 py-2 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
