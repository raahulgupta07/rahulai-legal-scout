"use client"

import { useEffect, useMemo, useState, useRef } from "react"
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  Building,
  ChevronDown,
  FileUp,
  Loader2,
  FileText,
  Users,
  MapPin,
  ScrollText,
  Sparkles,
  ArrowLeft,
  Brain,
} from "lucide-react"
import apiClient, { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import ReadOnlyNotice from "@/components/ui/ReadOnlyNotice"
import { useCanWrite } from "@/app/admin/roleClient"
import DocViewer from "@/components/ui/DocViewer"
import { cn } from "@/lib/utils"
import {
  Badge,
  Button,
  type Column,
  ConfirmButton,
  DataTable,
  EmptyState,
  IconButton,
  LoadingScreen,
  Modal,
  Notice,
  Page,
  PageBody,
  PageHeader,
  SearchInput,
  StatRow,
  StatTile,
  TextField,
  Toolbar,
  assertSuccess,
  ensureOk,
  errorMessage,
  focusRing,
  formatNumber,
} from "@/components/ui/kit"
import { TrainingLogPanel, type TrainingLogLine } from "../components/TrainingLogPanel"
import { useImportQueue } from "@/hooks/useImportQueue"

// ─── Types ──────────────────────────────────────────────────────────
interface Director {
  name: string; type: string; date_of_appointment: string; date_of_birth: string
  nationality: string; nrc_passport: string; gender: string; business_occupation: string
}
interface Member {
  type: string; name: string; registration_number: string; jurisdiction: string
  share_quantity: string; amount_paid: string; amount_unpaid: string; share_class: string
}
interface Filing { form_type: string; effective_date: string }
interface CompanyData { [key: string]: any; directors: Director[]; members: Member[]; filing_history: Filing[] }

const EMPTY: CompanyData = {
  company_name_english: "", company_name_myanmar: "",
  company_registration_number: "", registration_date: "", status: "",
  company_type: "", foreign_company: "", small_company: "",
  principal_activity: "", date_of_last_annual_return: "",
  previous_registration_number: "",
  registered_office_address: "", principal_place_of_business: "",
  directors: [],
  ultimate_holding_company_name: "", ultimate_holding_company_jurisdiction: "",
  ultimate_holding_company_registration_number: "",
  total_shares_issued: "", currency_of_share_capital: "",
  members: [], filing_history: [],
  financial_year_end_date: "", next_financial_year_end_date: "",
  auditor_name: "", auditor_fee: "",
}

interface RegistryField {
  field_key: string; label: string; description: string; field_type: string; used_by_templates: string[]
}

/** The fields a document actually needs. Drives the completeness column. */
const COMPLETENESS_FIELDS = [
  "company_name", "company_registration_number", "registered_office", "directors",
  "shareholders", "total_shares", "status", "company_type", "principal_activity", "registration_date",
]

const completeness = (c: Record<string, unknown>) => {
  const filled = COMPLETENESS_FIELDS.filter((f) => {
    const v = c[f]
    return v && String(v).trim() !== "" && v !== "—"
  }).length
  return Math.round((filled / COMPLETENESS_FIELDS.length) * 100)
}

const completenessTone = (pct: number) => (pct >= 80 ? "ok" : pct >= 50 ? "warn" : "danger")

// ─── Collapsible form section ───────────────────────────────────────
function Section({ title, icon, defaultOpen = true, meta, children }: {
  title: string; icon: React.ReactNode; defaultOpen?: boolean; meta?: React.ReactNode; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-[var(--border)] last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn("flex items-center justify-between w-full py-2.5 group text-left", focusRing)}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-[var(--text-muted)] shrink-0">{icon}</span>
          <span className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-secondary)] group-hover:text-[var(--text)] transition-colors">
            {title}
          </span>
          {meta}
        </span>
        <ChevronDown
          className={cn("w-3.5 h-3.5 text-[var(--text-muted)] transition-transform shrink-0", open && "rotate-180")}
        />
      </button>
      {open && <div className="pb-4">{children}</div>}
    </section>
  )
}

/** Repeating sub-record (a director, a member). */
function RepeaterCard({ title, onRemove, children }: {
  title: string; onRemove: () => void; children: React.ReactNode
}) {
  return (
    <div className="border border-[var(--border)] rounded-[var(--radius-sm)] p-3 mb-2 bg-[var(--bg-secondary)]">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-secondary)]">
          {title}
        </span>
        <Button size="sm" variant="ghost" className="text-[var(--danger-strong)]" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {children}
    </div>
  )
}

// ─── Company Form ───────────────────────────────────────────────────
function CompanyForm({ data, onChange, onSave, onCancel, saving, extracting, isEdit, registry }: {
  data: CompanyData; onChange: (d: CompanyData) => void
  onSave: () => void; onCancel: () => void; saving: boolean; extracting: boolean; isEdit: boolean
  registry?: RegistryField[]
}) {
  const set = (key: string, val: any) => onChange({ ...data, [key]: val })
  const setCustom = (key: string, val: any) =>
    onChange({ ...data, custom_fields: { ...(data.custom_fields || {}), [key]: val } })
  const setDirector = (i: number, key: string, val: string) => {
    const dirs = [...data.directors]; dirs[i] = { ...dirs[i], [key]: val }; onChange({ ...data, directors: dirs })
  }
  const setMember = (i: number, key: string, val: string) => {
    const mems = [...data.members]; mems[i] = { ...mems[i], [key]: val }; onChange({ ...data, members: mems })
  }

  if (extracting) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text-muted)]">
        <Loader2 className="w-6 h-6 animate-spin" />
        <p className="text-[length:var(--text-sm)]">Reading the PDF…</p>
      </div>
    )
  }

  const grid = "grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3"

  return (
    <>
      {/* Own scroller — `overscroll-contain` keeps a wheel that bottoms out here
          from continuing into the PDF pane beside it. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4">
        <Section title="Company information" icon={<Building className="w-3.5 h-3.5" />}>
          <div className={grid}>
            <TextField label="Company name (English)" value={data.company_name_english} onChange={(v) => set("company_name_english", v)} required wide />
            <TextField label="Company name (Myanmar)" value={data.company_name_myanmar} onChange={(v) => set("company_name_myanmar", v)} wide />
            <TextField label="Registration number" value={data.company_registration_number} onChange={(v) => set("company_registration_number", v)} required mono />
            <TextField label="Registration date" value={data.registration_date} onChange={(v) => set("registration_date", v)} type="date" />
            <TextField label="Status" value={data.status} onChange={(v) => set("status", v)} />
            <TextField label="Company type" value={data.company_type} onChange={(v) => set("company_type", v)} />
            <TextField label="Foreign company" value={data.foreign_company} onChange={(v) => set("foreign_company", v)} placeholder="Yes / No" />
            <TextField label="Small or big (DICA)" value={data.small_company} onChange={(v) => set("small_company", v)} placeholder="Small / Big" />
            <TextField label="Under CorpSec management" value={data.under_corpsec_management} onChange={(v) => set("under_corpsec_management", v)} placeholder="Yes / No" />
            <TextField label="Group company" value={data.group_company} onChange={(v) => set("group_company", v)} placeholder="Yes / No" />
            <TextField label="Principal activity" value={data.principal_activity} onChange={(v) => set("principal_activity", v)} wide />
            <TextField label="Last annual return" value={data.date_of_last_annual_return} onChange={(v) => set("date_of_last_annual_return", v)} type="date" />
            <TextField label="Previous reg. number" value={data.previous_registration_number} onChange={(v) => set("previous_registration_number", v)} mono />
          </div>
        </Section>

        <Section title="Addresses" icon={<MapPin className="w-3.5 h-3.5" />}>
          <div className="grid grid-cols-1 gap-3">
            <TextField label="Registered office address" value={data.registered_office_address} onChange={(v) => set("registered_office_address", v)} />
            <TextField label="Principal place of business" value={data.principal_place_of_business} onChange={(v) => set("principal_place_of_business", v)} />
          </div>
        </Section>

        <Section
          title="Directors"
          icon={<Users className="w-3.5 h-3.5" />}
          meta={<Badge tone="neutral">{data.directors?.length || 0}</Badge>}
        >
          {(data.directors || []).map((dir, i) => (
            <RepeaterCard
              key={i}
              title={`Director ${i + 1}`}
              onRemove={() => {
                const d = [...data.directors]; d.splice(i, 1); onChange({ ...data, directors: d })
              }}
            >
              <div className={grid}>
                <TextField label="Name" value={dir.name} onChange={(v) => setDirector(i, "name", v)} />
                <TextField label="Type" value={dir.type} onChange={(v) => setDirector(i, "type", v)} />
                <TextField label="Date of appointment" value={dir.date_of_appointment} onChange={(v) => setDirector(i, "date_of_appointment", v)} type="date" />
                <TextField label="Date of birth" value={dir.date_of_birth} onChange={(v) => setDirector(i, "date_of_birth", v)} type="date" />
                <TextField label="Nationality" value={dir.nationality} onChange={(v) => setDirector(i, "nationality", v)} />
                <TextField label="NRC / passport" value={dir.nrc_passport} onChange={(v) => setDirector(i, "nrc_passport", v)} mono />
                <TextField label="Gender" value={dir.gender} onChange={(v) => setDirector(i, "gender", v)} />
                <TextField label="Occupation" value={dir.business_occupation} onChange={(v) => setDirector(i, "business_occupation", v)} />
              </div>
            </RepeaterCard>
          ))}
          <Button
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() =>
              onChange({
                ...data,
                directors: [...(data.directors || []), {
                  name: "", type: "Director", date_of_appointment: "", date_of_birth: "",
                  nationality: "", nrc_passport: "", gender: "", business_occupation: "",
                }],
              })
            }
          >
            Add director
          </Button>
        </Section>

        <Section
          title="Ultimate holding company"
          icon={<Building className="w-3.5 h-3.5" />}
          defaultOpen={!!data.ultimate_holding_company_name}
        >
          <div className={grid}>
            <TextField label="Company name" value={data.ultimate_holding_company_name} onChange={(v) => set("ultimate_holding_company_name", v)} wide />
            <TextField label="Jurisdiction" value={data.ultimate_holding_company_jurisdiction} onChange={(v) => set("ultimate_holding_company_jurisdiction", v)} />
            <TextField label="Registration number" value={data.ultimate_holding_company_registration_number} onChange={(v) => set("ultimate_holding_company_registration_number", v)} mono />
          </div>
        </Section>

        <Section
          title="Share capital & members"
          icon={<ScrollText className="w-3.5 h-3.5" />}
          meta={<Badge tone="neutral">{data.members?.length || 0}</Badge>}
        >
          <div className={cn(grid, "mb-3")}>
            <TextField label="Total shares issued" value={data.total_shares_issued} onChange={(v) => set("total_shares_issued", v)} mono />
            <TextField label="Total capital" value={data.total_capital} onChange={(v) => set("total_capital", v)} placeholder="2,550,000,000" mono />
            <TextField label="Currency" value={data.currency_of_share_capital} onChange={(v) => set("currency_of_share_capital", v)} />
            <TextField label="Consideration (amount paid)" value={data.consideration_amount_paid} onChange={(v) => set("consideration_amount_paid", v)} mono />
          </div>
          {(data.members || []).map((mem, i) => (
            <RepeaterCard
              key={i}
              title={`${mem.type === "corporate" ? "Corporate" : "Individual"} member ${i + 1}`}
              onRemove={() => {
                const m = [...data.members]; m.splice(i, 1); onChange({ ...data, members: m })
              }}
            >
              <div className={grid}>
                <TextField label="Name" value={mem.name} onChange={(v) => setMember(i, "name", v)} wide />
                <TextField label="Type" value={mem.type} onChange={(v) => setMember(i, "type", v)} />
                <TextField label="Shares" value={mem.share_quantity} onChange={(v) => setMember(i, "share_quantity", v)} mono />
                <TextField label="Amount paid" value={mem.amount_paid} onChange={(v) => setMember(i, "amount_paid", v)} mono />
                <TextField label="Amount unpaid" value={mem.amount_unpaid} onChange={(v) => setMember(i, "amount_unpaid", v)} mono />
                <TextField label="Share class" value={mem.share_class} onChange={(v) => setMember(i, "share_class", v)} />
                {mem.type === "corporate" && (
                  <>
                    <TextField label="Reg. number" value={mem.registration_number} onChange={(v) => setMember(i, "registration_number", v)} mono />
                    <TextField label="Jurisdiction" value={mem.jurisdiction} onChange={(v) => setMember(i, "jurisdiction", v)} />
                  </>
                )}
              </div>
            </RepeaterCard>
          ))}
          <Button
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() =>
              onChange({
                ...data,
                members: [...(data.members || []), {
                  type: "individual", name: "", registration_number: "", jurisdiction: "",
                  share_quantity: "", amount_paid: "", amount_unpaid: "", share_class: "ORD",
                }],
              })
            }
          >
            Add member
          </Button>
        </Section>

        {registry && registry.length > 0 && (
          <Section
            title="Template required fields"
            icon={<Sparkles className="w-3.5 h-3.5" />}
            meta={<Badge tone="accent">{registry.length}</Badge>}
            defaultOpen={false}
          >
            <p className="mb-3 text-[length:var(--text-xs)] text-[var(--text-muted)]">
              Auto-discovered from trained templates. Fill any that apply — these are read during document generation.
            </p>
            <div className={grid}>
              {registry.map((rf) => (
                <TextField
                  key={rf.field_key}
                  label={rf.label}
                  value={(data.custom_fields || {})[rf.field_key] || ""}
                  onChange={(v) => setCustom(rf.field_key, v)}
                  placeholder={rf.description ? rf.description.slice(0, 60) : ""}
                  type={rf.field_type === "date" ? "date" : "text"}
                  wide={rf.field_type === "text" && rf.field_key.length > 25}
                />
              ))}
            </div>
          </Section>
        )}

        <Section
          title="Audit & financial year"
          icon={<ScrollText className="w-3.5 h-3.5" />}
          defaultOpen={!!(data.auditor_name || data.financial_year_end_date)}
        >
          <div className={grid}>
            <TextField label="Financial year end" value={data.financial_year_end_date} onChange={(v) => set("financial_year_end_date", v)} placeholder="31 March 2026" />
            <TextField label="Next financial year end" value={data.next_financial_year_end_date} onChange={(v) => set("next_financial_year_end_date", v)} placeholder="31 March 2027" />
            <TextField label="Auditor name" value={data.auditor_name} onChange={(v) => set("auditor_name", v)} placeholder="Audit firm or individual" wide />
            <TextField label="Auditor fee" value={data.auditor_fee} onChange={(v) => set("auditor_fee", v)} placeholder="500 USD" mono />
          </div>
        </Section>

        <Section
          title="Filing history"
          icon={<FileText className="w-3.5 h-3.5" />}
          meta={<Badge tone="neutral">{data.filing_history?.length || 0}</Badge>}
          defaultOpen={false}
        >
          {(data.filing_history || []).length === 0 ? (
            <p className="text-[length:var(--text-xs)] text-[var(--text-muted)]">No filing history on record.</p>
          ) : (
            <ul>
              {(data.filing_history || []).map((f, i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 py-1.5 border-b border-[var(--border)] last:border-b-0 text-[length:var(--text-xs)]"
                >
                  <span className="flex-1 text-[var(--text-secondary)]">{f.form_type}</span>
                  <span className="font-mono tabular-nums text-[var(--text)]">{f.effective_date}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border)] bg-[var(--surface)]">
        <Button variant="ghost" onClick={onCancel}>
          Back to list
        </Button>
        <Button
          variant="primary"
          onClick={onSave}
          loading={saving}
          disabled={!data.company_name_english}
          icon={<Check className="w-3.5 h-3.5" />}
        >
          {isEdit ? "Update company" : "Save company"}
        </Button>
      </div>
    </>
  )
}

// ─── Extract log (streaming ND-JSON) ────────────────────────────────
const STAGE_TONE: Record<string, string> = {
  error: "text-[var(--danger-strong)]",
  warn: "text-[var(--warn)]",
  done: "text-[var(--ok-strong)]",
  ai: "text-[var(--brand)]",
}

function ExtractLogPane({ logs }: { logs: { stage: string; msg: string }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" })
  }, [logs.length])

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--bg-secondary)]">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" />
        <span className="text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)]">
          Extracting company data
        </span>
      </div>
      <div
        ref={ref}
        role="log"
        aria-live="polite"
        className="flex-1 overflow-y-auto px-4 py-3 font-[family-name:var(--font-mono)] text-[length:var(--text-2xs)] leading-5"
      >
        {logs.length === 0 && <div className="text-[var(--text-muted)]">Waiting for events…</div>}
        {logs.map((l, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-[var(--text-muted)] shrink-0 tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className={cn("whitespace-pre-wrap break-words", STAGE_TONE[l.stage] ?? "text-[var(--text-secondary)]")}>
              {l.msg}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Split view: PDF beside the form ────────────────────────────────
function SplitView({
  pdfUrl, formData, onChange, onSave, onCancel, saving, extracting, isEdit,
  onExtract, pdfReady, extractLogs, registry,
}: {
  pdfUrl: string | null; formData: CompanyData; onChange: (d: CompanyData) => void
  onSave: () => void; onCancel: () => void; saving: boolean; extracting: boolean
  isEdit: boolean; onExtract?: () => void; pdfReady?: boolean; extractLogs?: { stage: string; msg: string }[]
  registry?: RegistryField[]
}) {
  return (
    <Page>
      <PageHeader
        back={<IconButton aria-label="Back to companies" onClick={onCancel} icon={<ArrowLeft className="w-4 h-4" />} />}
        title={isEdit ? "Edit company" : "New company from PDF"}
        meta={formData.company_name_english ? <Badge tone="accent">{formData.company_name_english}</Badge> : undefined}
      />
      {/* Two independent scroll panes. `overflow-hidden` here stops the split
          from growing past the tab band, which is what used to make the whole
          screen scroll as one — dragging the form along with the PDF. */}
      <div className="flex flex-1 min-h-0 overflow-hidden split-view-mobile">
        <div className="w-1/2 flex flex-col min-w-0 min-h-0 border-r border-[var(--border)]">
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
            <span className="flex items-center gap-2 text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)]">
              <FileText className="w-3.5 h-3.5" /> Source PDF
            </span>
            {/* Extraction now starts by itself on upload; this is the retry
                path for when it failed and the form is still empty. */}
            {pdfReady && onExtract && !extracting && !formData.company_name_english && (
              <Button variant="primary" size="sm" onClick={() => onExtract()} icon={<Sparkles className="w-3.5 h-3.5" />}>
                Retry extraction
              </Button>
            )}
            {extracting && (
              <Badge tone="warn" dot>
                Extracting
              </Badge>
            )}
          </div>
          {pdfUrl ? (
            // PdfViewer renders at natural height by design, so the scroller
            // lives here — the PDF scrolls without touching the form.
            <div className="flex-1 min-h-0 overflow-auto overscroll-contain">
              <DocViewer url={`${process.env.NEXT_PUBLIC_API_URL || ""}${pdfUrl}`} className="w-full" />
            </div>
          ) : (
            <div className="flex-1 grid place-items-center text-[length:var(--text-sm)] text-[var(--text-muted)]">
              No PDF available
            </div>
          )}
        </div>

        <div className="w-1/2 flex flex-col min-w-0 min-h-0">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
            <Building className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <span className="text-[length:var(--text-xs)] font-medium text-[var(--text-secondary)]">
              {extracting
                ? "Extracting…"
                : formData.company_name_english
                  ? "Company data — review & edit"
                  : "Waiting for extraction"}
            </span>
          </div>
          {extracting ? (
            <ExtractLogPane logs={extractLogs || []} />
          ) : !formData.company_name_english && !isEdit ? (
            <div className="flex-1 grid place-items-center px-8">
              <div className="text-center max-w-xs">
                <Sparkles className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
                <p className="mt-3 text-[length:var(--text-sm)] font-medium text-[var(--text)]">
                  Nothing was read from this PDF
                </p>
                <p className="mt-1 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                  Extraction runs automatically on upload. Use <strong>Retry extraction</strong> above the PDF, or go
                  back and enter the company by hand.
                </p>
              </div>
            </div>
          ) : (
            <CompanyForm
              data={formData} onChange={onChange} onSave={onSave} onCancel={onCancel}
              saving={saving} extracting={extracting} isEdit={isEdit} registry={registry}
            />
          )}
        </div>
      </div>
    </Page>
  )
}

// ─── Create choice (modal body) ─────────────────────────────────────
/**
 * Body content for the "Create a company" modal. The Modal primitive owns the
 * title bar, ✕ and backdrop — this renders only the dropzone + manual link.
 */
function CreateCompanyChoice({ onFiles, onBrowse, onManual }: {
  onFiles: (files: File[]) => void; onBrowse: () => void; onManual: () => void
}) {
  const [dragging, setDragging] = useState(false)

  const isPdf = (f: File) =>
    f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")

  return (
    <div className="space-y-4">
      {/* PRIMARY: dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          // Multi-file drop: everything that is a PDF goes into the import
          // queue, and non-PDFs are reported once rather than per file.
          const dropped = Array.from(e.dataTransfer.files || [])
          if (dropped.length === 0) return
          const pdfs = dropped.filter(isPdf)
          const rejected = dropped.length - pdfs.length
          if (rejected > 0) toast.error(`${rejected} file${rejected === 1 ? "" : "s"} skipped — PDFs only`)
          if (pdfs.length > 0) onFiles(pdfs)
        }}
        className={cn(
          "flex flex-col items-center gap-3 px-6 py-10 text-center rounded-[var(--radius-sm)]",
          "border-2 border-dashed transition-colors"
        )}
        style={{
          borderColor: dragging ? "var(--accent)" : "var(--border-strong)",
          backgroundColor: dragging
            ? "color-mix(in srgb, var(--accent) 8%, transparent)"
            : "transparent",
        }}
      >
        <span className="w-10 h-10 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-sm)]">
          <FileUp className="w-4 h-4 text-[var(--text-secondary)]" />
        </span>
        <span>
          <span className="flex items-center justify-center gap-2">
            <span className="text-[length:var(--text-sm)] font-medium text-[var(--text)]">
              Drop DICA Company Extracts here
            </span>
            <Badge tone="accent">Recommended</Badge>
          </span>
          <span className="block mt-1 text-[length:var(--text-xs)] text-[var(--text-muted)]">
            or{" "}
            <button
              type="button"
              onClick={onBrowse}
              className={cn(
                "font-medium text-[var(--brand)] underline underline-offset-2 hover:opacity-80 transition-opacity rounded-[var(--radius-sm)]",
                focusRing
              )}
            >
              browse files
            </button>
          </span>
        </span>
        <span className="block max-w-sm text-[length:var(--text-xs)] text-[var(--text-muted)]">
          Drop one or many. Each is read and saved automatically; anything ambiguous waits for you in
          the import tray.
        </span>
        <span className="text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
          PDF · English extract
        </span>
      </div>

      {/* DIVIDER */}
      <div className="flex items-center gap-3 text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
        <span className="flex-1 h-px bg-[var(--border)]" />
        or
        <span className="flex-1 h-px bg-[var(--border)]" />
      </div>

      {/* SECONDARY: manual link */}
      <div className="text-center">
        <button
          type="button"
          onClick={onManual}
          className={cn(
            "text-[length:var(--text-sm)] text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors rounded-[var(--radius-sm)] px-2 py-1",
            focusRing
          )}
        >
          Have no PDF? Fill in manually
        </button>
      </div>
    </div>
  )
}

// ─── Main page ──────────────────────────────────────────────────────
type PageView = "list" | "choice" | "pdf" | "manual" | "edit" | "view"

export default function CompaniesView() {
  // Rendering only. The server refuses the write regardless (require_write).
  const mayWrite = useCanWrite()
  const [companies, setCompanies] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [view, setView] = useState<PageView>("list")

  const [extracting, setExtracting] = useState(false)
  const [extractLogs, setExtractLogs] = useState<{ stage: string; msg: string }[]>([])
  const [registry, setRegistry] = useState<RegistryField[]>([])
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfReady, setPdfReady] = useState(false)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [formData, setFormData] = useState<CompanyData>({ ...EMPTY })
  const [saving, setSaving] = useState(false)

  const [isTraining, setIsTraining] = useState(false)
  const [trainingComplete, setTrainingComplete] = useState(false)
  const [lastTrained, setLastTrained] = useState<string | null>(null)
  const [showTrainingLog, setShowTrainingLog] = useState(false)
  const [trainingLogs, setTrainingLogs] = useState<TrainingLogLine[]>([])

  const pdfInputRef = useRef<HTMLInputElement>(null)

  // Bulk PDF import runs in the globally-mounted tray, not on this page, so it
  // survives navigating away. `savedTick` fires whenever the queue writes a
  // company, which is our cue to refresh the table underneath it.
  const enqueueImport = useImportQueue((s) => s.enqueue)
  const importSavedTick = useImportQueue((s) => s.savedTick)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    fetchCompanies()
    fetchRegistry()
    // Abort a live training stream if the operator navigates away mid-run.
    return () => abortControllerRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The import tray writes companies straight to the register; pull the table
  // back into step each time it does. Skipped on first mount (tick 0).
  useEffect(() => {
    if (importSavedTick > 0) fetchCompanies()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importSavedTick])

  const fetchRegistry = async () => {
    try {
      const res = await authFetch(apiClient.fieldRegistry())
      await ensureOk(res, "Failed to load the field registry")
      const data = await res.json()
      setRegistry(data.fields || [])
    } catch (e) {
      // Non-fatal: the form still works, it just will not show template fields.
      console.error("Field registry load error:", e)
    }
  }

  useEffect(() => {
    if (trainingComplete && trainingLogs.length > 0 && !isTraining) {
      authFetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/training/save-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "companies", logs: trainingLogs }),
      }).catch((e) => console.error("Save training logs error:", e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainingComplete])

  const fetchCompanies = async () => {
    setLoadError("")
    try {
      const res = await authFetch(apiClient.getDashboardData())
      await ensureOk(res, "Failed to load companies")
      const data = await res.json()
      setCompanies(data.companies || [])

      try {
        const tRes = await authFetch(apiClient.getTrainingStatus())
        await ensureOk(tRes, "Failed to load training status")
        const tData = await tRes.json()
        if (tData.data?.companies) {
          if (tData.data.companies.last_trained) {
            setLastTrained(new Date(tData.data.companies.last_trained).toLocaleString())
          }
          if (tData.data.companies.logs?.length > 0) {
            setTrainingLogs(tData.data.companies.logs)
            setTrainingComplete(true)
          }
        }
      } catch (e) {
        console.error("Training status error:", e)
      }
    } catch (e: any) {
      console.error("Companies load error:", e)
      setLoadError(e?.message || "Failed to load companies")
      toast.error(e?.message || "Failed to load companies")
    } finally {
      setLoading(false)
    }
  }

  const resetState = () => {
    setPdfUrl(null); setPdfFile(null); setPdfReady(false); setExtracting(false)
    setFormData({ ...EMPTY }); setSaving(false)
  }

  const handleCreateNew = () => { resetState(); setView("choice") }
  const handleChoosePdf = () => pdfInputRef.current?.click()
  const handleChooseManual = () => { resetState(); setView("manual") }

  /**
   * The import tray parks anything it could not save on its own and sends the
   * operator here with the extracted record in sessionStorage. We drop it into
   * the normal review screen rather than building a second form.
   */
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    if (params.get("review") !== "1") return
    try {
      const raw = sessionStorage.getItem("ls_import_review")
      sessionStorage.removeItem("ls_import_review")
      if (!raw) return
      const d = JSON.parse(raw)
      resetState()
      setFormData({ ...EMPTY, ...d })
      if (d.pdf_url) {
        setPdfUrl(d.pdf_url)
        setPdfReady(true)
      }
      setView("pdf")
    } catch (e) {
      console.error("Could not open the queued import for review:", e)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Every PDF — one or fifty — goes to the background import queue. The old
   * behaviour opened a split review screen per file, which is exactly the
   * per-file babysitting the team asked us to remove. The tray reports what
   * happened to each, and only the ambiguous ones ever need opening.
   */
  const importPdfs = (files: File[]) => {
    if (files.length === 0) return
    enqueueImport(files)
    // view "choice" IS the modal, so returning to the list closes it.
    resetState()
    setView("list")
    toast.success(
      `${files.length} file${files.length === 1 ? "" : "s"} queued — watch progress in the import tray`
    )
  }

  const handlePdfUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
    if (pdfInputRef.current) pdfInputRef.current.value = ""
    importPdfs(picked)
  }

  /**
   * `file` is passed explicitly by the auto-run in startPdf: that call happens
   * in the same tick as setPdfFile, so the `pdfFile` state here would still be
   * null. Manual retries from the button pass nothing and use state.
   */
  const handleExtract = async (file?: File) => {
    const source = file || pdfFile
    if (!source) return
    setExtracting(true)
    setExtractLogs([])
    const fd = new FormData()
    fd.append("file", source)
    try {
      const res = await authFetch(apiClient.extractCompanyPdfStream(), { method: "POST", body: fd })
      if (!res.ok || !res.body) throw new Error(await errorMessage(res, "Extraction failed"))

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      let finalEvt: any = null

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() || ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const ev = JSON.parse(trimmed)
            setExtractLogs((prev) => [...prev, { stage: ev.stage, msg: ev.msg }])
            if (ev.stage === "done" || ev.stage === "error") finalEvt = ev
          } catch (err) {
            console.error("Extract stream parse error:", err)
          }
        }
      }

      if (finalEvt?.stage === "done" && finalEvt.data) {
        const d = finalEvt.data
        d.directors = d.directors || []
        d.members = d.members || []
        d.filing_history = d.filing_history || []
        d.pdf_url = finalEvt.pdf_url || pdfUrl
        setFormData(d)
        if (finalEvt.pdf_url) setPdfUrl(finalEvt.pdf_url)
        toast.success(`Extracted ${d.company_name_english || "company"}`)
      } else {
        toast.error(finalEvt?.msg || "Extraction failed")
      }
    } catch (err: any) {
      console.error("Extract error:", err)
      toast.error(err?.message || "Failed to extract")
    } finally {
      setExtracting(false)
    }
  }

  /** Shared by view and edit: load the full record, fall back to the list row. */
  const openCompany = async (company: any, target: "view" | "edit") => {
    resetState()
    if (company.id) {
      try {
        const res = await authFetch(apiClient.getCompany(company.id))
        await ensureOk(res, "Failed to load company")
        const data = await res.json()
        if (data.data) {
          const c = data.data
          c.directors = c.directors || []
          c.members = c.members || []
          c.filing_history = c.filing_history || []
          setFormData(c)
          setPdfUrl(c.pdf_url || null)
          setView(target)
          return
        }
      } catch (e: any) {
        console.error("Open company error:", e)
        toast.error(e?.message || "Failed to load the full record — showing summary data")
      }
    }
    setFormData({
      ...EMPTY,
      company_name_english: company.company_name || "",
      company_registration_number: company.company_registration_number || "",
      registered_office_address: company.registered_office || "",
      directors: (company.directors || "")
        .split(",")
        .filter((n: string) => n.trim())
        .map((n: string) => ({
          name: n.trim(), type: "Director", date_of_appointment: "", date_of_birth: "",
          nationality: "", nrc_passport: "", gender: "", business_occupation: "",
        })),
      members: [],
      filing_history: [],
    })
    setView(target)
  }

  const handleSave = async () => {
    if (!formData.company_name_english) {
      toast.error("Company name is required")
      return
    }
    setSaving(true)
    try {
      const payload = { ...formData, source: view === "edit" ? "edited" : "pdf_extract" }
      const res = await authFetch(apiClient.addCompany(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Save failed"))
      await assertSuccess(res, "Save failed")
      toast.success(`"${formData.company_name_english}" saved`)
      await fetchCompanies()
      setView("list")
      resetState()
    } catch (e: any) {
      console.error("Save error:", e)
      toast.error(e?.message || "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  const handleBack = () => { setView("list"); resetState() }

  const handleDelete = async (name: string) => {
    try {
      const res = await authFetch(apiClient.deleteCompany(name), { method: "DELETE" })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to delete company"))
      const body = await res.json()
      if (!body?.success) throw new Error(body?.error || "Failed to delete company")
      // Server message carries the count of people removed with the company.
      toast.success(body.message || `"${name}" deleted`)
      await fetchCompanies()
    } catch (e: any) {
      console.error("Delete error:", e)
      toast.error(e?.message || "Failed to delete")
    }
  }

  const addLog = (msg: string, type: string = "info") =>
    setTrainingLogs((prev) => [...prev, { time: new Date().toLocaleTimeString(), msg, type }])

  const handleTrainAgent = async () => {
    const token = localStorage.getItem("ls_token")
    if (!token) {
      toast.error("Please sign in again")
      return
    }

    setIsTraining(true)
    setTrainingComplete(false)
    setTrainingLogs([])
    setShowTrainingLog(true)

    const controller = new AbortController()
    abortControllerRef.current = controller

    addLog("Company deep training", "info")

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/knowledge/train-companies-stream`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })

      if (!res.ok) {
        const msg = await errorMessage(res, "Training failed")
        addLog(msg, "error")
        toast.error(msg)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        addLog("Stream failed to open", "error")
        return
      }
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          try {
            const step = JSON.parse(line.slice(6))
            const s = step.step
            const m = step.msg

            if (s === "company_done") {
              const risk = step.risks > 0 ? ` · ${step.risks} risks` : ""
              const miss = step.missing > 0 ? ` · ${step.missing} missing` : ""
              addLog(`${step.company} — ${step.compliance}${risk}${miss}`, "success")
            } else if (s === "summary") {
              addLog(`Companies synced: ${step.total}`, "success")
              addLog(`AI analysed: ${step.analyzed}/${step.total}`, "success")
              addLog("Embeddings generated, agent knowledge refreshed", "success")
            } else if (s === "done") {
              setTrainingComplete(true)
              setLastTrained(new Date().toLocaleString())
              toast.success("Agent trained")
            } else if (s === "error" || s?.endsWith("_warn")) {
              addLog(m, "error")
            } else if (s?.endsWith("_start") || s === "ai_skip") {
              addLog(m, "processing")
            } else if (s === "load" || s === "sync" || s === "embed" || s === "ai_done") {
              addLog(m, "success")
            } else {
              addLog(m, "info")
            }
          } catch (e) {
            console.error("SSE parse error:", e)
          }
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return
      console.error("Train agent error:", e)
      addLog("Connection failed", "error")
      toast.error("Failed to train agent")
    } finally {
      abortControllerRef.current = null
      setIsTraining(false)
    }
  }

  const term = searchTerm.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      term
        ? companies.filter(
            (c) =>
              (c.company_name || "").toLowerCase().includes(term) ||
              (c.company_registration_number || "").toLowerCase().includes(term)
          )
        : companies,
    [companies, term]
  )

  const stats = useMemo(() => {
    const scores = companies.map(completeness)
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
    return {
      total: companies.length,
      needsWork: scores.filter((s) => s < 80).length,
      complete: scores.filter((s) => s >= 80).length,
      avg,
    }
  }, [companies])

  if (loading) return <LoadingScreen label="Loading companies" />

  const hiddenPdfInput = (
    <input ref={pdfInputRef} type="file" accept=".pdf" multiple onChange={handlePdfUpload} className="hidden" />
  )

  if (view === "pdf") {
    return (
      <>
        {hiddenPdfInput}
        <SplitView
          pdfUrl={pdfUrl} formData={formData} onChange={setFormData}
          onSave={handleSave} onCancel={handleBack} saving={saving} extracting={extracting}
          isEdit={false} onExtract={handleExtract} pdfReady={pdfReady}
          extractLogs={extractLogs} registry={registry}
        />
      </>
    )
  }

  if (view === "manual") {
    return (
      <>
        {hiddenPdfInput}
        <Page>
          <PageHeader
            back={<IconButton aria-label="Back to companies" onClick={handleBack} icon={<ArrowLeft className="w-4 h-4" />} />}
            title="New company"
            meta={<Badge tone="neutral">Manual entry</Badge>}
          />
          <CompanyForm
            data={formData} onChange={setFormData} onSave={handleSave} onCancel={handleBack}
            saving={saving} extracting={false} isEdit={false} registry={registry}
          />
        </Page>
      </>
    )
  }

  if (view === "edit" || view === "view") {
    if (pdfUrl) {
      return (
        <>
          {hiddenPdfInput}
          <SplitView
            pdfUrl={pdfUrl} formData={formData} onChange={setFormData}
            onSave={handleSave} onCancel={handleBack} saving={saving} extracting={false}
            isEdit pdfReady={false} registry={registry}
          />
        </>
      )
    }
    return (
      <>
        {hiddenPdfInput}
        <Page>
          <PageHeader
            back={<IconButton aria-label="Back to companies" onClick={handleBack} icon={<ArrowLeft className="w-4 h-4" />} />}
            title={formData.company_name_english || (view === "view" ? "Company details" : "Edit company")}
            meta={view === "view" ? <Badge tone="neutral">Read only</Badge> : <Badge tone="accent">Editing</Badge>}
            actions={mayWrite ? (<>
              view === "view" ? (
                <Button variant="primary" onClick={() => setView("edit")} icon={<Pencil className="w-3.5 h-3.5" />}>
                  Edit
                </Button>
              ) : undefined
            </>) : undefined}
          />
          <CompanyForm
            data={formData} onChange={setFormData} onSave={handleSave} onCancel={handleBack}
            saving={saving} extracting={false} isEdit registry={registry}
          />
        </Page>
      </>
    )
  }

  // ── List ──
  const columns: Column<any>[] = [
    {
      key: "company_name",
      header: "Company",
      sortValue: (c) => c.company_name,
      render: (c) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-7 h-7 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-sm)]">
            <Building className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-[var(--text)] truncate max-w-[220px]">{c.company_name}</span>
            {c.status && (
              <span className="block text-[length:var(--text-2xs)] text-[var(--text-muted)]">{c.status}</span>
            )}
          </span>
        </div>
      ),
    },
    {
      key: "company_registration_number",
      header: "Reg. no.",
      sortValue: (c) => c.company_registration_number,
      render: (c) => <span className="font-mono tabular-nums">{c.company_registration_number || "—"}</span>,
    },
    {
      key: "directors",
      header: "Directors",
      hideBelow: "md",
      render: (c) => <span className="block max-w-[200px] truncate">{c.directors || "—"}</span>,
    },
    {
      key: "shareholders",
      header: "Shareholders",
      hideBelow: "lg",
      render: (c) => <span className="block max-w-[200px] truncate">{c.shareholders || "—"}</span>,
    },
    {
      key: "total_shares",
      header: "Shares",
      numeric: true,
      hideBelow: "sm",
      sortValue: (c) => Number(String(c.total_shares || "").replace(/[^0-9.]/g, "")) || null,
      render: (c) => c.total_shares || "—",
    },
    {
      key: "completeness",
      header: "Complete",
      align: "right",
      sortValue: (c) => completeness(c),
      render: (c) => {
        const pct = completeness(c)
        return (
          <Badge tone={completenessTone(pct)} dot>
            {pct}%
          </Badge>
        )
      },
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "1%",
      stopClickPropagation: true,
      render: (c) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton
            aria-label={`Edit ${c.company_name}`}
            title="Edit"
            onClick={() => openCompany(c, "edit")}
            icon={<Pencil className="w-3.5 h-3.5" />}
          />
          <ConfirmButton
            compact
            label={`Delete ${c.company_name}`}
            icon={<Trash2 className="w-3.5 h-3.5" />}
            onConfirm={() => handleDelete(c.company_name)}
          />
        </div>
      ),
    },
  ]

  return (
    <>
      {hiddenPdfInput}

      <Modal
        open={view === "choice"}
        onOpenChange={(o) => {
          if (!o) handleBack()
        }}
        title="Create a company"
        description="Start from a DICA Company Extract, or enter the details by hand."
        size="md"
      >
        <CreateCompanyChoice
          onFiles={importPdfs}
          onBrowse={handleChoosePdf}
          onManual={handleChooseManual}
        />
      </Modal>

      <Page>
        <PageHeader
          title="Companies"
          meta={
            <>
              <Badge tone="neutral">{companies.length}</Badge>
              {isTraining && <Badge tone="warn" dot>Training</Badge>}
              {trainingComplete && !isTraining && <Badge tone="ok" dot>Agent trained</Badge>}
            </>
          }
          description="Company records fill the placeholders in every generated document. Train the agent after changing them."
          actions={mayWrite ? (<>
            <>
              <Button onClick={() => setShowTrainingLog(true)} icon={<Brain className="w-4 h-4" />}>
                {isTraining ? "View progress" : "Training log"}
              </Button>
              <Button
                onClick={handleTrainAgent}
                loading={isTraining}
                disabled={companies.length === 0}
                icon={<Sparkles className="w-4 h-4" />}
              >
                {isTraining ? "Training" : "Train agent"}
              </Button>
              <Button variant="primary" onClick={handleCreateNew} icon={<Plus className="w-4 h-4" />}>
                Create company
              </Button>
            </>
          </>) : undefined}
        />

        {companies.length > 0 && (
          <Toolbar>
            <SearchInput
              label="Search companies by name or registration number"
              placeholder="Name or registration number…"
              value={searchTerm}
              onChange={setSearchTerm}
            />
            <span className="ml-auto flex items-center gap-3 text-[length:var(--text-xs)] text-[var(--text-muted)]">
              {lastTrained && <span>Last trained {lastTrained}</span>}
              <span className="tabular-nums">
                {filtered.length} of {companies.length}
              </span>
            </span>
          </Toolbar>
        )}

        <PageBody className="space-y-4">
        <ReadOnlyNotice what="the company register" />
          {loadError && <Notice tone="danger" title="Could not load companies">{loadError}</Notice>}

          {companies.length === 0 ? (
            <EmptyState
              icon={<Building className="w-4 h-4" />}
              title="No companies yet"
              description="Company data is what every generated document is filled from."
              steps={[
                { title: "Add a company", body: "Upload a DICA Company Extract PDF, or enter the details by hand." },
                { title: "Review the extraction", body: "AI fills the form; you confirm directors, members and share capital." },
                { title: "Train the agent", body: "Training refreshes what the agent knows about your companies." },
              ]}
              action={
                <Button variant="primary" onClick={handleCreateNew} icon={<Plus className="w-4 h-4" />}>
                  Create the first company
                </Button>
              }
            />
          ) : (
            <>
              <StatRow>
                <StatTile label="Companies" value={formatNumber(stats.total)} />
                <StatTile label="Document ready" value={stats.complete} hint="80% of fields or better" />
                <StatTile
                  label="Needs attention"
                  value={stats.needsWork}
                  tone={stats.needsWork > 0 ? "warn" : undefined}
                  hint={stats.needsWork > 0 ? "Below 80% complete" : "All records healthy"}
                />
                <StatTile label="Average completeness" value={`${stats.avg}%`} />
              </StatRow>

              <DataTable
                rows={filtered}
                columns={columns}
                rowKey={(c, i) => c.id ?? `${c.company_name}-${i}`}
                onRowClick={(c) => openCompany(c, "view")}
                caption="Companies"
                rowTone={(c) => {
                  const pct = completeness(c)
                  return pct >= 80 ? null : pct >= 50 ? "var(--warn)" : "var(--danger-strong)"
                }}
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

        <TrainingLogPanel
          open={showTrainingLog}
          onClose={() => setShowTrainingLog(false)}
          title="Company training log"
          logs={trainingLogs}
          running={isTraining}
          complete={trainingComplete}
        />
      </Page>
    </>
  )
}
