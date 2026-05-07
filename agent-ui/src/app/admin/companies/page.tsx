"use client"

import { useEffect, useState, useRef } from "react"
import { Plus, Search, Trash2, Pencil, X, Check, Building, ChevronDown, ChevronUp, FileUp, Loader2, FileText, Users, MapPin, ScrollText, Sparkles, ArrowLeft, Brain, CheckCircle } from "lucide-react"
import apiClient, { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import DocViewer from "@/components/ui/DocViewer"

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

interface RegistryField { field_key: string; label: string; description: string; field_type: string; used_by_templates: string[] }

// ─── Reusable Components ────────────────────────────────────────────
function Section({ title, icon, defaultOpen = true, children }: {
  title: string; icon: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mb-3">
      <button onClick={() => setOpen(!open)} className="flex items-center justify-between w-full py-2 group">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted group-hover:text-primary transition-colors">{title}</span>
        </div>
        {open ? <ChevronUp className="w-3 h-3 text-muted" /> : <ChevronDown className="w-3 h-3 text-muted" />}
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  )
}

function Field({ label, value, onChange, type = "text", placeholder = "", wide = false, required = false }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; wide?: boolean; required?: boolean
}) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <label className="block text-[11px] font-medium text-muted mb-0.5">
        {label}{required && <span className="text-brand ml-0.5">*</span>}
      </label>
      <input type={type} value={value || ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-2.5 py-1.5 text-sm bg-background border border-primary/10 rounded-lg text-primary placeholder:text-muted/40 focus:outline-none focus:border-brand/40 focus:ring-1 focus:ring-brand/20 transition-colors"
      />
    </div>
  )
}

// ─── Company Form (right panel) ─────────────────────────────────────
function CompanyForm({ data, onChange, onSave, onCancel, saving, extracting, isEdit, registry }: {
  data: CompanyData; onChange: (d: CompanyData) => void
  onSave: () => void; onCancel: () => void; saving: boolean; extracting: boolean; isEdit: boolean
  registry?: RegistryField[]
}) {
  const set = (key: string, val: any) => onChange({ ...data, [key]: val })
  const setCustom = (key: string, val: any) => onChange({ ...data, custom_fields: { ...(data.custom_fields || {}), [key]: val } })
  const setDirector = (i: number, key: string, val: string) => {
    const dirs = [...data.directors]; dirs[i] = { ...dirs[i], [key]: val }; onChange({ ...data, directors: dirs })
  }
  const setMember = (i: number, key: string, val: string) => {
    const mems = [...data.members]; mems[i] = { ...mems[i], [key]: val }; onChange({ ...data, members: mems })
  }

  if (extracting) return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <Loader2 className="w-8 h-8 animate-spin text-brand" />
      <p className="text-sm text-muted">Dash is reading the PDF...</p>
    </div>
  )

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <Section title="Company Information" icon={<Building className="w-3.5 h-3.5 text-brand" />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <Field label="Company Name (English)" value={data.company_name_english} onChange={v => set("company_name_english", v)} required wide />
            <Field label="Company Name (Myanmar)" value={data.company_name_myanmar} onChange={v => set("company_name_myanmar", v)} wide />
            <Field label="Registration Number" value={data.company_registration_number} onChange={v => set("company_registration_number", v)} required />
            <Field label="Registration Date" value={data.registration_date} onChange={v => set("registration_date", v)} type="date" />
            <Field label="Status" value={data.status} onChange={v => set("status", v)} />
            <Field label="Company Type" value={data.company_type} onChange={v => set("company_type", v)} />
            <Field label="Foreign Company" value={data.foreign_company} onChange={v => set("foreign_company", v)} placeholder="Yes/No" />
            <Field label="Small/Big Company (DICA)" value={data.small_company} onChange={v => set("small_company", v)} placeholder="Small/Big" />
            <Field label="Under CorpSec Management" value={data.under_corpsec_management} onChange={v => set("under_corpsec_management", v)} placeholder="Yes/No" />
            <Field label="Group Company" value={data.group_company} onChange={v => set("group_company", v)} placeholder="Yes/No" />
            <Field label="Principal Activity" value={data.principal_activity} onChange={v => set("principal_activity", v)} wide />
            <Field label="Last Annual Return" value={data.date_of_last_annual_return} onChange={v => set("date_of_last_annual_return", v)} type="date" />
            <Field label="Previous Reg Number" value={data.previous_registration_number} onChange={v => set("previous_registration_number", v)} />
          </div>
        </Section>

        <Section title="Addresses" icon={<MapPin className="w-3.5 h-3.5 text-blue-500" />}>
          <div className="grid grid-cols-1 gap-2.5">
            <Field label="Registered Office Address" value={data.registered_office_address} onChange={v => set("registered_office_address", v)} wide />
            <Field label="Principal Place of Business" value={data.principal_place_of_business} onChange={v => set("principal_place_of_business", v)} wide />
          </div>
        </Section>

        <Section title={`Directors (${data.directors?.length || 0})`} icon={<Users className="w-3.5 h-3.5 text-green-600" />}>
          {(data.directors || []).map((dir, i) => (
            <div key={i} className="border border-primary/8 rounded-lg p-3 mb-2 bg-accent/20">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-primary">Director {i + 1}</span>
                <button onClick={() => { const d = [...data.directors]; d.splice(i, 1); onChange({ ...data, directors: d }) }} className="text-xs text-red-500 hover:underline">Remove</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Name" value={dir.name} onChange={v => setDirector(i, "name", v)} />
                <Field label="Type" value={dir.type} onChange={v => setDirector(i, "type", v)} />
                <Field label="Date of Appointment" value={dir.date_of_appointment} onChange={v => setDirector(i, "date_of_appointment", v)} type="date" />
                <Field label="Date of Birth" value={dir.date_of_birth} onChange={v => setDirector(i, "date_of_birth", v)} type="date" />
                <Field label="Nationality" value={dir.nationality} onChange={v => setDirector(i, "nationality", v)} />
                <Field label="NRC/Passport" value={dir.nrc_passport} onChange={v => setDirector(i, "nrc_passport", v)} />
                <Field label="Gender" value={dir.gender} onChange={v => setDirector(i, "gender", v)} />
                <Field label="Occupation" value={dir.business_occupation} onChange={v => setDirector(i, "business_occupation", v)} />
              </div>
            </div>
          ))}
          <button onClick={() => onChange({ ...data, directors: [...(data.directors || []), { name: "", type: "Director", date_of_appointment: "", date_of_birth: "", nationality: "", nrc_passport: "", gender: "", business_occupation: "" }] })}
            className="text-xs text-brand hover:underline mt-1">+ Add Director</button>
        </Section>

        <Section title="Ultimate Holding Company" icon={<Building className="w-3.5 h-3.5 text-purple-500" />} defaultOpen={!!data.ultimate_holding_company_name}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <Field label="Company Name" value={data.ultimate_holding_company_name} onChange={v => set("ultimate_holding_company_name", v)} wide />
            <Field label="Jurisdiction" value={data.ultimate_holding_company_jurisdiction} onChange={v => set("ultimate_holding_company_jurisdiction", v)} />
            <Field label="Registration Number" value={data.ultimate_holding_company_registration_number} onChange={v => set("ultimate_holding_company_registration_number", v)} />
          </div>
        </Section>

        <Section title={`Share Capital & Members (${data.members?.length || 0})`} icon={<ScrollText className="w-3.5 h-3.5 text-amber-500" />}>
          <div className="grid grid-cols-2 gap-2.5 mb-3">
            <Field label="Total Shares Issued" value={data.total_shares_issued} onChange={v => set("total_shares_issued", v)} />
            <Field label="Total Capital" value={data.total_capital} onChange={v => set("total_capital", v)} placeholder="e.g. 2,550,000,000" />
            <Field label="Currency" value={data.currency_of_share_capital} onChange={v => set("currency_of_share_capital", v)} />
            <Field label="Consideration (Amount Paid)" value={data.consideration_amount_paid} onChange={v => set("consideration_amount_paid", v)} placeholder="Total amount paid" />
          </div>
          {(data.members || []).map((mem, i) => (
            <div key={i} className="border border-primary/8 rounded-lg p-3 mb-2 bg-accent/20">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-primary">{mem.type === "corporate" ? "Corporate" : "Individual"} Member {i + 1}</span>
                <button onClick={() => { const m = [...data.members]; m.splice(i, 1); onChange({ ...data, members: m }) }} className="text-xs text-red-500 hover:underline">Remove</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Name" value={mem.name} onChange={v => setMember(i, "name", v)} wide />
                <Field label="Type" value={mem.type} onChange={v => setMember(i, "type", v)} />
                <Field label="Shares" value={mem.share_quantity} onChange={v => setMember(i, "share_quantity", v)} />
                <Field label="Amount Paid" value={mem.amount_paid} onChange={v => setMember(i, "amount_paid", v)} />
                <Field label="Amount Unpaid" value={mem.amount_unpaid} onChange={v => setMember(i, "amount_unpaid", v)} />
                <Field label="Share Class" value={mem.share_class} onChange={v => setMember(i, "share_class", v)} />
                {mem.type === "corporate" && <>
                  <Field label="Reg Number" value={mem.registration_number} onChange={v => setMember(i, "registration_number", v)} />
                  <Field label="Jurisdiction" value={mem.jurisdiction} onChange={v => setMember(i, "jurisdiction", v)} />
                </>}
              </div>
            </div>
          ))}
          <button onClick={() => onChange({ ...data, members: [...(data.members || []), { type: "individual", name: "", registration_number: "", jurisdiction: "", share_quantity: "", amount_paid: "", amount_unpaid: "", share_class: "ORD" }] })}
            className="text-xs text-brand hover:underline mt-1">+ Add Member</button>
        </Section>

        {registry && registry.length > 0 && (
          <Section title={`Template Required Fields (${registry.length})`} icon={<Sparkles className="w-3.5 h-3.5 text-purple-500" />} defaultOpen={false}>
            <p className="text-[10px] text-muted mb-2">Auto-discovered from trained templates. Fill any that apply — used during document generation.</p>
            <div className="grid grid-cols-2 gap-2.5">
              {registry.map(rf => (
                <Field
                  key={rf.field_key}
                  label={rf.label}
                  value={(data.custom_fields || {})[rf.field_key] || ""}
                  onChange={v => setCustom(rf.field_key, v)}
                  placeholder={rf.description ? rf.description.slice(0, 60) : ""}
                  type={rf.field_type === "date" ? "date" : "text"}
                  wide={rf.field_type === "text" && rf.field_key.length > 25}
                />
              ))}
            </div>
          </Section>
        )}

        <Section title="Audit & Financial Year" icon={<ScrollText className="w-3.5 h-3.5 text-orange-500" />} defaultOpen={!!(data.auditor_name || data.financial_year_end_date)}>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Financial Year End Date" value={data.financial_year_end_date} onChange={v => set("financial_year_end_date", v)} placeholder="e.g. 31 March 2026" />
            <Field label="Next Financial Year End" value={data.next_financial_year_end_date} onChange={v => set("next_financial_year_end_date", v)} placeholder="e.g. 31 March 2027" />
            <Field label="Auditor Name" value={data.auditor_name} onChange={v => set("auditor_name", v)} placeholder="Audit firm or individual" wide />
            <Field label="Auditor Fee" value={data.auditor_fee} onChange={v => set("auditor_fee", v)} placeholder="e.g. 500 USD" />
          </div>
        </Section>

        <Section title={`Filing History (${data.filing_history?.length || 0})`} icon={<FileText className="w-3.5 h-3.5 text-gray-500" />} defaultOpen={false}>
          {(data.filing_history || []).map((f, i) => (
            <div key={i} className="flex items-center gap-3 text-xs py-1.5 border-b border-primary/5">
              <span className="text-muted flex-1">{f.form_type}</span>
              <span className="text-primary font-mono">{f.effective_date}</span>
            </div>
          ))}
          {(!data.filing_history || data.filing_history.length === 0) && <p className="text-xs text-muted/60">No filing history</p>}
        </Section>
      </div>

      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-primary/10 bg-accent/20">
        <button onClick={onCancel} className="px-4 py-2 text-xs font-medium text-muted hover:text-primary rounded-lg hover:bg-accent">Back to List</button>
        <button onClick={onSave} disabled={saving || !data.company_name_english}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/80 disabled:opacity-40">
          <Check className="w-3.5 h-3.5" />{saving ? "Saving..." : isEdit ? "Update Company" : "Save Company"}
        </button>
      </div>
    </>
  )
}

// ─── Extract Log Pane (streaming) ───────────────────────────────────
function ExtractLogPane({ logs }: { logs: { stage: string; msg: string }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" }) }, [logs.length])
  const icon = (s: string) =>
    s === "upload" ? "⬆" : s === "save" ? "💾" : s === "parse" ? "📖" :
    s === "ai" ? "🤖" : s === "warn" ? "⚠" : s === "done" ? "✅" : s === "error" ? "✗" : "•"
  const color = (s: string) =>
    s === "error" ? "text-red-500" : s === "warn" ? "text-amber-500" :
    s === "done" ? "text-green-600" : s === "ai" ? "text-brand" : "text-primary/80"
  return (
    <div className="flex-1 flex flex-col bg-[#1a1a1a] text-green-400 font-mono text-xs overflow-hidden">
      <div className="px-4 py-2 border-b border-green-900/30 flex items-center gap-2 bg-black/40">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span className="text-green-300">$ scout extract --stream</span>
      </div>
      <div ref={ref} className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
        {logs.length === 0 && <div className="text-green-700">Waiting for events…</div>}
        {logs.map((l, i) => (
          <div key={i} className={`flex gap-2 ${color(l.stage).replace('text-','text-')}`}>
            <span className="text-green-700 shrink-0">[{String(i + 1).padStart(2, "0")}]</span>
            <span className="shrink-0">{icon(l.stage)}</span>
            <span className="whitespace-pre-wrap break-words text-green-200">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Split View (PDF left + Form right) ─────────────────────────────
function SplitView({ pdfUrl, formData, onChange, onSave, onCancel, saving, extracting, isEdit, onExtract, pdfReady, extractLogs, registry }: {
  pdfUrl: string | null; formData: CompanyData; onChange: (d: CompanyData) => void
  onSave: () => void; onCancel: () => void; saving: boolean; extracting: boolean
  isEdit: boolean; onExtract?: () => void; pdfReady?: boolean; extractLogs?: { stage: string; msg: string }[]
  registry?: RegistryField[]
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-primary/10 bg-card">
        <div className="flex items-center gap-3">
          <button onClick={onCancel} className="p-1.5 rounded-lg hover:bg-accent text-muted hover:text-primary"><ArrowLeft className="w-4 h-4" /></button>
          <h1 className="text-lg font-semibold text-primary">{isEdit ? "Edit Company" : "New Company from PDF"}</h1>
          {formData.company_name_english && <span className="text-xs text-brand bg-brand/10 px-2 py-0.5 rounded-full">{formData.company_name_english}</span>}
        </div>
      </div>
      <div className="flex flex-1 gap-0 overflow-hidden">
        {/* Left: PDF */}
        <div className="w-1/2 flex flex-col border-r border-primary/10">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-primary/10 bg-accent/30">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-brand" />
              <span className="text-xs font-semibold text-primary">PDF Document</span>
            </div>
            {/* Extract button — only show when PDF loaded but not yet extracted */}
            {pdfReady && onExtract && !extracting && !formData.company_name_english && (
              <button onClick={onExtract}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-brand text-white rounded-lg hover:bg-brand/90 animate-pulse">
                <Sparkles className="w-3.5 h-3.5" /> Extract with AI
              </button>
            )}
            {extracting && (
              <div className="flex items-center gap-1.5 text-xs text-brand">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Extracting...
              </div>
            )}
          </div>
          {pdfUrl ? (
            <DocViewer url={`${process.env.NEXT_PUBLIC_API_URL || ''}${pdfUrl}`} className="flex-1 w-full" />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted text-sm">No PDF available</div>
          )}
        </div>
        {/* Right: Form */}
        <div className="w-1/2 flex flex-col">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-primary/10 bg-accent/30">
            <div className="flex items-center gap-2">
              <Building className="w-4 h-4 text-brand" />
              <span className="text-xs font-semibold text-primary">
                {extracting ? "Extracting..." : formData.company_name_english ? "Company Data — Review & Edit" : "Waiting for extraction..."}
              </span>
            </div>
          </div>
          {extracting ? (
            <ExtractLogPane logs={extractLogs || []} />
          ) : !formData.company_name_english && !isEdit ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
              <Sparkles className="w-12 h-12 text-brand/30" />
              <div>
                <p className="text-sm font-medium text-primary">PDF uploaded</p>
                <p className="text-xs text-muted mt-1">Click "Extract with AI" button above the PDF to read and fill the form automatically.</p>
              </div>
            </div>
          ) : (
            <CompanyForm data={formData} onChange={onChange} onSave={onSave} onCancel={onCancel}
              saving={saving} extracting={extracting} isEdit={isEdit} registry={registry} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Create New Company Choice Screen ───────────────────────────────
function CreateChoiceScreen({ onUploadPdf, onManual, onCancel }: {
  onUploadPdf: () => void; onManual: () => void; onCancel: () => void
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-primary/10 bg-card">
        <button onClick={onCancel} className="p-1.5 rounded-lg hover:bg-accent text-muted hover:text-primary"><ArrowLeft className="w-4 h-4" /></button>
        <h1 className="text-lg font-semibold text-primary">Create New Company</h1>
      </div>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="flex gap-6 max-w-2xl w-full">
          {/* Option 1: Upload PDF */}
          <button onClick={onUploadPdf}
            className="flex-1 flex flex-col items-center gap-4 p-8 border-2 border-dashed border-primary/15 rounded-2xl hover:border-brand/40 hover:bg-brand/5 transition-all group cursor-pointer">
            <div className="w-16 h-16 rounded-2xl bg-brand/10 flex items-center justify-center group-hover:bg-brand/20 transition-colors">
              <FileUp className="w-8 h-8 text-brand" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-primary">Upload DICA PDF</p>
              <p className="text-xs text-muted mt-1">Upload a Company Extract PDF and AI will automatically fill all fields</p>
            </div>
            <span className="text-[11px] font-medium text-brand bg-brand/10 px-3 py-1 rounded-full">Recommended</span>
          </button>

          {/* Option 2: Manual */}
          <button onClick={onManual}
            className="flex-1 flex flex-col items-center gap-4 p-8 border-2 border-dashed border-primary/15 rounded-2xl hover:border-primary/30 hover:bg-accent/50 transition-all group cursor-pointer">
            <div className="w-16 h-16 rounded-2xl bg-accent flex items-center justify-center group-hover:bg-accent/80 transition-colors">
              <Pencil className="w-8 h-8 text-muted" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-primary">Fill Manually</p>
              <p className="text-xs text-muted mt-1">Enter all company information by hand using the form</p>
            </div>
            <span className="text-[11px] font-medium text-muted bg-accent px-3 py-1 rounded-full">Manual Entry</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ──────────────────────────────────────────────────────
type PageView = "list" | "choice" | "pdf" | "manual" | "edit" | "view"

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
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
  const [trainingLogs, setTrainingLogs] = useState<{ time: string; msg: string; type: string }[]>([])

  const pdfInputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  useEffect(() => { fetchCompanies(); fetchRegistry() }, [])

  const fetchRegistry = async () => {
    try {
      const res = await authFetch(apiClient.fieldRegistry())
      const data = await res.json()
      if (data.success) setRegistry(data.fields || [])
    } catch {}
  }

  // Save company training logs when training completes
  useEffect(() => {
    if (trainingComplete && trainingLogs.length > 0 && !isTraining) {
      authFetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/training/save-logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "companies", logs: trainingLogs })
      }).catch((e) => { console.error("Save training logs error:", e) })
    }
  }, [trainingComplete])

  const fetchCompanies = async () => {
    try {
      const res = await authFetch(apiClient.getDashboardData())
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json()
      setCompanies(data.companies || [])
      // Fetch training status + persisted logs
      try {
        const tRes = await authFetch(apiClient.getTrainingStatus())
        if (!tRes.ok) throw new Error(`Request failed: ${tRes.status}`)
        const tData = await tRes.json()
        if (tData.success && tData.data?.companies) {
          if (tData.data.companies.last_trained) {
            setLastTrained(new Date(tData.data.companies.last_trained).toLocaleString())
          }
          if (tData.data.companies.logs && tData.data.companies.logs.length > 0) {
            setTrainingLogs(tData.data.companies.logs)
            setTrainingComplete(true)
          }
        }
      } catch (e) { console.error("Training status error:", e) }
    } catch (e) { console.error("Companies load error:", e) } finally { setLoading(false) }
  }

  const resetState = () => {
    setPdfUrl(null); setPdfFile(null); setPdfReady(false); setExtracting(false)
    setFormData({ ...EMPTY }); setSaving(false)
  }

  // ── "Create New Company" button → choice screen ──
  const handleCreateNew = () => { resetState(); setView("choice") }

  // ── Choice: Upload PDF ──
  const handleChoosePdf = () => { pdfInputRef.current?.click() }

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    resetState()
    setPdfFile(file)
    setView("pdf")

    const fd = new FormData(); fd.append("file", file)
    try {
      const res = await authFetch(apiClient.uploadCompanyPdf(), { method: "POST", body: fd })
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json()
      if (data.success) { setPdfUrl(data.pdf_url); setPdfReady(true) }
      else toast.error(data.error || "Upload failed")
    } catch (e) { console.error("PDF upload error:", e); toast.error("Failed to upload PDF") }

    if (pdfInputRef.current) pdfInputRef.current.value = ""
  }

  // ── Choice: Manual ──
  const handleChooseManual = () => { resetState(); setView("manual") }

  // ── Extract with AI (streaming logs) ──
  const handleExtract = async () => {
    if (!pdfFile) return
    setExtracting(true)
    setExtractLogs([])
    const fd = new FormData(); fd.append("file", pdfFile)
    try {
      const res = await authFetch(apiClient.extractCompanyPdfStream(), { method: "POST", body: fd })
      if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`)

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
            setExtractLogs(prev => [...prev, { stage: ev.stage, msg: ev.msg }])
            if (ev.stage === "done" || ev.stage === "error") finalEvt = ev
          } catch {}
        }
      }

      if (finalEvt?.stage === "done" && finalEvt.data) {
        const d = finalEvt.data
        d.directors = d.directors || []; d.members = d.members || []; d.filing_history = d.filing_history || []
        d.pdf_url = finalEvt.pdf_url || pdfUrl
        setFormData(d)
        if (finalEvt.pdf_url) setPdfUrl(finalEvt.pdf_url)
        toast.success(`Extracted: ${d.company_name_english || "Company"}`)
      } else {
        toast.error(finalEvt?.msg || "Extraction failed")
      }
    } catch (e) { console.error("Extract error:", e); toast.error("Failed to extract") }
    finally { setExtracting(false) }
  }

  // ── View company (click row) ──
  const handleView = async (company: any) => {
    resetState()
    if (company.id) {
      try {
        const res = await authFetch(apiClient.getCompany(company.id))
        if (!res.ok) throw new Error(`Request failed: ${res.status}`)
        const data = await res.json()
        if (data.success && data.data) {
          const c = data.data
          c.directors = c.directors || []; c.members = c.members || []; c.filing_history = c.filing_history || []
          setFormData(c)
          setPdfUrl(c.pdf_url || null)
          setView("view")
          return
        }
      } catch (e) { console.error("View company error:", e) }
    }
    // Fallback
    setFormData({
      ...EMPTY,
      company_name_english: company.company_name || "",
      company_registration_number: company.company_registration_number || "",
      registered_office_address: company.registered_office || "",
      directors: (company.directors || "").split(",").filter((n: string) => n.trim()).map((n: string) => ({
        name: n.trim(), type: "Director", date_of_appointment: "", date_of_birth: "",
        nationality: "", nrc_passport: "", gender: "", business_occupation: ""
      })),
      members: [], filing_history: [],
    })
    setView("view")
  }

  // ── Edit existing company ──
  const handleEdit = async (company: any) => {
    resetState()
    if (company.id) {
      try {
        const res = await authFetch(apiClient.getCompany(company.id))
        if (!res.ok) throw new Error(`Request failed: ${res.status}`)
        const data = await res.json()
        if (data.success && data.data) {
          const c = data.data
          c.directors = c.directors || []; c.members = c.members || []; c.filing_history = c.filing_history || []
          setFormData(c)
          setPdfUrl(c.pdf_url || null)
          setView("edit")
          return
        }
      } catch (e) { console.error("Edit company error:", e) }
    }
    // Fallback
    setFormData({
      ...EMPTY,
      company_name_english: company.company_name || "",
      company_registration_number: company.company_registration_number || "",
      registered_office_address: company.registered_office || "",
      directors: (company.directors || "").split(",").filter((n: string) => n.trim()).map((n: string) => ({
        name: n.trim(), type: "Director", date_of_appointment: "", date_of_birth: "",
        nationality: "", nrc_passport: "", gender: "", business_occupation: ""
      })),
      members: [], filing_history: [],
    })
    setView("edit")
  }

  // ── Save → go back to list ──
  const handleSave = async () => {
    if (!formData.company_name_english) { toast.error("Company name required"); return }
    setSaving(true)
    try {
      const payload = { ...formData, source: view === "edit" ? "edited" : "pdf_extract" }
      const res = await authFetch(apiClient.addCompany(), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      })
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json()
      if (data.success) {
        toast.success(`"${formData.company_name_english}" saved`)
        await fetchCompanies()
        setView("list")
        resetState()
      } else toast.error(data.error || "Save failed")
    } catch (e) { console.error("Save error:", e); toast.error("Failed to save") } finally { setSaving(false) }
  }

  const handleBack = () => { setView("list"); resetState() }

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete "${name}"?`)) return
    try {
      const res = await authFetch(apiClient.deleteCompany(name), { method: "DELETE" })
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      const data = await res.json()
      if (data.success) { toast.success("Deleted"); await fetchCompanies() }
      else toast.error(data.error || "Failed")
    } catch (e) { console.error("Delete error:", e); toast.error("Failed to delete") }
  }

  const addLog = (msg: string, type: string = "info") => {
    const time = new Date().toLocaleTimeString()
    setTrainingLogs(prev => [...prev, { time, msg, type }])
  }

  const handleTrainAgent = async () => {
    const token = localStorage.getItem("ls_token")
    if (!token) {
      toast.error("Please log in again")
      return
    }

    setIsTraining(true)
    setTrainingComplete(false)
    setTrainingLogs([])
    setShowTrainingLog(true)

    const controller = new AbortController()
    abortControllerRef.current = controller

    addLog("━".repeat(55), "info")
    addLog("🧠 COMPANY DEEP TRAINING", "info")
    addLog("━".repeat(55), "info")

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/knowledge/train-companies-stream`, {
        headers: { "Authorization": `Bearer ${token}` },
        signal: controller.signal,
      })

      if (!res.ok) {
        addLog(`✗ Training failed: ${res.status}`, "error")
        toast.error(`Training failed: ${res.status}`)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) { addLog("✗ Stream failed", "error"); return }
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

            if (s === "start") addLog(`📋 ${m}`, "info")
            else if (s === "load") addLog(`📦 ${m}`, "success")
            else if (s === "sync_start") addLog(`💾 ${m}`, "processing")
            else if (s === "sync") addLog(`✓ ${m}`, "success")
            else if (s === "sync_warn") addLog(`⚠ ${m}`, "error")
            else if (s === "ai_start") addLog(`🤖 ${m}`, "processing")
            else if (s === "company_start") addLog(`  🏢 ${m}`, "processing")
            else if (s === "company_done") {
              const risk = step.risks > 0 ? ` ⚠${step.risks} risks` : ""
              const miss = step.missing > 0 ? ` 📋${step.missing} missing` : ""
              addLog(`  ✓ ${step.company} — ${step.compliance}${risk}${miss}`, "success")
            }
            else if (s === "company_warn") addLog(`  ⚠ ${m}`, "error")
            else if (s === "ai_done") addLog(`🤖 ${m}`, "success")
            else if (s === "ai_skip") addLog(`⚠ ${m}`, "processing")
            else if (s === "embed_start") addLog(`🔢 ${m}`, "processing")
            else if (s === "embed") addLog(`🔢 ${m}`, "success")
            else if (s === "embed_warn") addLog(`⚠ ${m}`, "error")
            else if (s === "summary") {
              addLog("", "info")
              addLog("━".repeat(55), "success")
              addLog("✅ COMPANY TRAINING COMPLETE", "success")
              addLog("━".repeat(55), "success")
              addLog(`  🏢 Companies:     ${step.total} synced`, "success")
              addLog(`  🤖 AI analyzed:   ${step.analyzed}/${step.total}`, "success")
              addLog(`  🔢 Embeddings:    Generated`, "success")
              addLog(`  🧠 Agent:         Knowledge refreshed`, "success")
              addLog("━".repeat(55), "success")
            }
            else if (s === "done") {
              setTrainingComplete(true)
              setLastTrained(new Date().toLocaleString())
              toast.success("Agent trained successfully!")
            }
            else if (s === "error") addLog(`✗ ${m}`, "error")
            else addLog(`  ${m}`, "info")
          } catch (e) { console.error("SSE parse error:", e) }
        }
      }
    } catch (e) {
      addLog("✗ Connection failed", "error")
      toast.error("Failed to train agent")
    } finally {
      abortControllerRef.current = null
      setIsTraining(false)
    }
  }

  const filtered = companies.filter(c =>
    (c.company_name || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
    (c.company_registration_number || "").toLowerCase().includes(searchTerm.toLowerCase())
  )

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="w-8 h-8 animate-spin text-brand" /></div>

  // Hidden file input (always in DOM)
  const hiddenPdfInput = <input ref={pdfInputRef} type="file" accept=".pdf" onChange={handlePdfUpload} className="hidden" />

  // ── Choice Screen ──
  if (view === "choice") return (
    <>{hiddenPdfInput}<CreateChoiceScreen onUploadPdf={handleChoosePdf} onManual={handleChooseManual} onCancel={handleBack} /></>
  )

  // ── PDF Split View ──
  if (view === "pdf") return (
    <>{hiddenPdfInput}<SplitView pdfUrl={pdfUrl} formData={formData} onChange={setFormData}
      onSave={handleSave} onCancel={handleBack} saving={saving} extracting={extracting}
      isEdit={false} onExtract={handleExtract} pdfReady={pdfReady} extractLogs={extractLogs} registry={registry} /></>
  )

  // ── Manual Form (full-width, no PDF) ──
  if (view === "manual") return (
    <>{hiddenPdfInput}
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-primary/10 bg-card">
        <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-accent text-muted hover:text-primary"><ArrowLeft className="w-4 h-4" /></button>
        <h1 className="text-lg font-semibold text-primary">New Company — Manual Entry</h1>
      </div>
      <CompanyForm data={formData} onChange={setFormData} onSave={handleSave} onCancel={handleBack}
        saving={saving} extracting={false} isEdit={false} registry={registry} />
    </div></>
  )

  // ── View / Edit (split view with PDF if available, otherwise full form) ──
  if (view === "edit" || view === "view") return (
    <>{hiddenPdfInput}
    {pdfUrl ? (
      <SplitView pdfUrl={pdfUrl} formData={formData} onChange={setFormData}
        onSave={handleSave} onCancel={handleBack} saving={saving} extracting={false}
        isEdit={true} pdfReady={false} registry={registry} />
    ) : (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between p-4 border-b border-primary/10 bg-card">
          <div className="flex items-center gap-3">
            <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-accent text-muted hover:text-primary"><ArrowLeft className="w-4 h-4" /></button>
            <h1 className="text-lg font-semibold text-primary">{view === "view" ? "Company Details" : "Edit Company"}</h1>
            {formData.company_name_english && <span className="text-xs text-brand bg-brand/10 px-2 py-0.5 rounded-full">{formData.company_name_english}</span>}
          </div>
          {view === "view" && (
            <button onClick={() => setView("edit")} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/80">
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
          )}
        </div>
        <CompanyForm data={formData} onChange={setFormData} onSave={handleSave} onCancel={handleBack}
          saving={saving} extracting={false} isEdit={true} />
      </div>
    )}</>
  )

  // ── Company List ──
  return (
    <>{hiddenPdfInput}    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-primary/10 bg-card">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-primary">Companies</h1>
          <span className="text-xs text-muted bg-accent rounded-full px-2 py-0.5">{companies.length}</span>
          {isTraining && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-500/10 rounded-lg">
              <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
              <span className="text-xs text-orange-700">Training agent...</span>
            </div>
          )}
          {trainingComplete && !isTraining && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 rounded-lg">
              <CheckCircle className="w-4 h-4 text-green-600" />
              <span className="text-xs text-green-700">Agent Trained!</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowTrainingLog(true)}
            className="flex items-center gap-2 px-3 py-2 text-xs font-medium border border-primary/10 rounded-lg hover:bg-accent">
            <Brain className="w-4 h-4" />
            {isTraining ? "View Progress" : trainingComplete ? "View Last Training" : "Training Logs"}
            {isTraining && <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>}
          </button>
          <button onClick={handleTrainAgent} disabled={isTraining || companies.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-gradient-to-r from-orange-500 to-red-600 text-white rounded-lg hover:from-orange-600 hover:to-red-700 disabled:opacity-50">
            <Sparkles className={`w-4 h-4 ${isTraining ? "animate-spin" : ""}`} />
            {isTraining ? "Training..." : "Train Agent"}
          </button>
          <button onClick={handleCreateNew} className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/80">
            <Plus className="w-4 h-4" />Create New Company
          </button>
        </div>
      </div>
      {lastTrained && (
        <div className="px-4 py-2 bg-green-500/10 border-b border-green-500/20 text-xs text-green-700">
          ✓ Last trained: {lastTrained}
        </div>
      )}

      <div className="p-4 border-b border-primary/10">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input type="text" placeholder="Search companies..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-background border border-primary/10 rounded-lg text-primary placeholder:text-muted/50 focus:outline-none focus:border-brand/40" />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="border border-primary/10 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-accent/30">
              <tr className="text-left text-xs text-muted border-b border-primary/10">
                <th className="px-4 py-3 font-medium">Company Name</th>
                <th className="px-4 py-3 font-medium">Reg No.</th>
                <th className="px-4 py-3 font-medium">Directors</th>
                <th className="px-4 py-3 font-medium">Shareholders</th>
                <th className="px-4 py-3 font-medium">Shares</th>
                <th className="px-4 py-3 font-medium">Completeness</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-primary/5">
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Building className="w-8 h-8 text-muted/40" />
                    <p className="text-sm text-muted">No companies found</p>
                    <button onClick={handleCreateNew} className="text-xs text-brand hover:underline">+ Create your first company</button>
                  </div>
                </td></tr>
              ) : filtered.map((c, i) => (
                <tr key={i} className="hover:bg-accent/30 transition-colors cursor-pointer" onClick={() => handleView(c)}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-md bg-brand/8 flex items-center justify-center shrink-0"><Building className="w-3.5 h-3.5 text-brand" /></div>
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-primary block truncate max-w-[180px]">{c.company_name}</span>
                        <span className="text-[11px] text-muted">{c.status}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted font-mono">{c.company_registration_number}</td>
                  <td className="px-4 py-3 text-sm text-muted max-w-[180px] truncate">{c.directors || "—"}</td>
                  <td className="px-4 py-3 text-sm text-muted max-w-[180px] truncate">{c.shareholders || "—"}</td>
                  <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">{c.total_shares || "—"}</td>
                  <td className="px-4 py-3">
                    {(() => {
                      const fields = ["company_name", "company_registration_number", "registered_office", "directors", "shareholders", "total_shares", "status", "company_type", "principal_activity", "registration_date"]
                      const filled = fields.filter(f => {
                        const v = c[f]
                        return v && String(v).trim() !== "" && v !== "—"
                      }).length
                      const pct = Math.round((filled / fields.length) * 100)
                      const color = pct >= 80 ? "text-green-600 bg-green-500/10" : pct >= 50 ? "text-yellow-600 bg-yellow-500/10" : "text-red-600 bg-red-500/10"
                      return (
                        <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${color}`}>
                          {pct}%
                        </span>
                      )
                    })()}
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => handleEdit(c)} className="p-1.5 text-muted hover:text-brand hover:bg-brand/10 rounded-lg" title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDelete(c.company_name)} className="p-1.5 text-muted hover:text-red-500 hover:bg-red-500/10 rounded-lg" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted mt-2">Showing {filtered.length} of {companies.length} companies</p>
      </div>

      {/* Training Log Modal */}
      {showTrainingLog && (
        <div className="fixed bottom-4 right-4 w-[500px] max-h-[70vh] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-800">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-green-500" />
              <span className="text-sm font-medium text-white">Company Training Log</span>
              {isTraining && <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>}
            </div>
            <button onClick={() => setShowTrainingLog(false)} className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-1 max-h-[50vh]">
            {trainingLogs.length === 0 ? (
              <p className="text-gray-500 text-center py-8">Click "Train Agent" to start training</p>
            ) : trainingLogs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-gray-600 shrink-0">[{log.time}]</span>
                <span className={
                  log.type === "success" ? "text-green-400" :
                  log.type === "error" ? "text-red-400" :
                  log.type === "processing" ? "text-yellow-300" :
                  log.type === "ai" ? "text-purple-400" :
                  "text-gray-300"
                }>{log.msg}</span>
              </div>
            ))}
          </div>
          <div className="px-4 py-2 border-t border-gray-700 bg-gray-800 flex items-center justify-between">
            <span className="text-xs text-gray-500">{trainingLogs.length} log entries</span>
            {trainingComplete && (
              <span className="text-xs text-green-400 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> Complete
              </span>
            )}
          </div>
        </div>
      )}
    </div></>
  )
}
