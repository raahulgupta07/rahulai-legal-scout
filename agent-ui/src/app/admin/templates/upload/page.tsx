"use client"

import { useState, useRef } from "react"
import { ArrowLeft, CheckCircle2, Sparkles, Upload, XCircle } from "lucide-react"
import Link from "next/link"
import apiClient, { authFetch } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import {
  Badge,
  Button,
  Card,
  IconButton,
  Notice,
  Page,
  PageBody,
  PageHeader,
  assertSuccess,
  errorMessage,
  focusRing,
} from "@/components/ui/kit"
import { STEP_DEFS } from "../../components/TrainingProgress"

interface UploadResult {
  success: boolean
  message: string
  template_name?: string
  fields?: string[]
}

export default function UploadPage() {
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".docx")) {
      setResult({ success: false, message: "That is not a .docx file. Templates must be Word documents." })
      return
    }

    setUploading(true)
    setResult(null)

    const formData = new FormData()
    formData.append("file", file)

    try {
      const res = await authFetch(apiClient.uploadTemplate(), { method: "POST", body: formData })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to upload template"))
      // A rejected upload comes back as HTTP 200 with success:false.
      await assertSuccess(res, "Failed to upload template")
      const data = await res.json()

      setResult({
        success: true,
        message: `"${data.template_name || file.name}" uploaded`,
        template_name: data.template_name,
        fields: data.fields,
      })

      if (data.analyze) {
        setAnalyzing(true)
        try {
          const aRes = await authFetch(apiClient.analyzeTemplate(), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `name=${encodeURIComponent(data.template_name)}`,
          })
          await assertSuccess(aRes, "Analysis failed")
        } catch (e) {
          // The template is uploaded either way; analysis can be re-run from
          // the templates screen, so this is reported but not fatal.
          console.error("Analyze error:", e)
        } finally {
          setAnalyzing(false)
        }
      }
    } catch (error: any) {
      console.error("Upload error:", error)
      setResult({ success: false, message: error?.message || "Failed to upload template" })
    } finally {
      setUploading(false)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) upload(file)
  }

  return (
    <Page>
      <PageHeader
        back={
          <Link href="/admin/templates" aria-label="Back to templates">
            <IconButton aria-label="Back to templates" icon={<ArrowLeft className="w-4 h-4" />} />
          </Link>
        }
        title="Upload a template"
        description="A template is a Word document containing placeholders. Once trained, the agent fills them from company data."
      />

      <PageBody>
        <div className="max-w-3xl mx-auto space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            onChange={handleFileChange}
            className="hidden"
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              const file = e.dataTransfer.files?.[0]
              if (file) upload(file)
            }}
            className={cn(
              "w-full flex flex-col items-center gap-3 px-6 py-10 text-center transition-colors",
              "bg-[var(--surface)] border border-dashed rounded-[var(--radius-sm)]",
              dragging ? "border-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_5%,var(--surface))]" : "border-[var(--border-strong)]",
              "disabled:opacity-60",
              focusRing
            )}
          >
            <span className="w-10 h-10 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-sm)]">
              <Upload className={cn("w-4 h-4 text-[var(--text-secondary)]", uploading && "animate-pulse")} />
            </span>
            <span>
              <span className="block text-[length:var(--text-sm)] font-medium text-[var(--text)]">
                {uploading ? "Uploading…" : "Drop a .docx here, or choose a file"}
              </span>
              <span className="mt-1 block text-[length:var(--text-xs)] text-[var(--text-muted)]">
                Placeholders may be written {"{{field}}"}, {"{field}"} or {"[field]"}
              </span>
            </span>
          </button>

          {result && (
            <div
              className="px-4 py-3 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-sm)]"
              style={{
                boxShadow: `inset 3px 0 0 0 ${result.success ? "var(--ok-strong)" : "var(--danger-strong)"}`,
              }}
            >
              <div className="flex items-start gap-2.5">
                {result.success ? (
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-[var(--ok-strong)]" />
                ) : (
                  <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--danger-strong)]" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[length:var(--text-sm)] font-medium text-[var(--text)]">{result.message}</p>

                  {analyzing && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                      <Sparkles className="w-3.5 h-3.5 animate-pulse" /> Analysing the template…
                    </p>
                  )}

                  {result.success && result.fields && result.fields.length > 0 && (
                    <div className="mt-3">
                      <p className="mb-1.5 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                        {result.fields.length} placeholder{result.fields.length === 1 ? "" : "s"} found
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {result.fields.slice(0, 12).map((field, i) => (
                          <Badge key={i} tone="neutral">
                            {field}
                          </Badge>
                        ))}
                        {result.fields.length > 12 && (
                          <Badge tone="neutral">+{result.fields.length - 12} more</Badge>
                        )}
                      </div>
                    </div>
                  )}

                  {result.success && (
                    <div className="mt-4 flex gap-2">
                      <Link href="/admin/templates">
                        <Button variant="primary">Train it now</Button>
                      </Link>
                      <Button
                        onClick={() => {
                          setResult(null)
                          if (fileInputRef.current) fileInputRef.current.value = ""
                        }}
                      >
                        Upload another
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {result?.success && (
            <Notice title="Uploading is not training">
              The agent cannot use this template until it has been trained. Training runs the fifteen steps below and
              takes roughly nine AI calls per template.
            </Notice>
          )}

          <Card title="What training will do" meta={<Badge tone="neutral">15 steps</Badge>}>
            <ol className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-1.5">
              {STEP_DEFS.map((s) => (
                <li key={s.key} className="flex gap-2.5 min-w-0">
                  <span className="text-[length:var(--text-2xs)] tabular-nums text-[var(--text-muted)] w-6 shrink-0 pt-0.5">
                    {s.num}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[length:var(--text-sm)] text-[var(--text)]">{s.name}</span>
                    <span className="block text-[length:var(--text-2xs)] text-[var(--text-muted)]">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </PageBody>
    </Page>
  )
}
