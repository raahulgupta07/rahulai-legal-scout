"use client"

import { useCallback, useEffect, useState } from "react"
import {
  ArrowLeft,
  Building,
  Check,
  Contact,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserPlus,
  X,
} from "lucide-react"
import apiClient, { authFetch } from "@/lib/api-client"
import { toast } from "sonner"

// ─── Types ──────────────────────────────────────────────────────────
type Role = "director" | "individual_shareholder" | "both"

interface CompanyLink {
  id?: number
  company_id: number
  company_name?: string
  role: Role
  number_of_shares?: string | null
  capital_amount?: string | null
  share_class?: string | null
  appointed_date?: string | null
  resigned_date?: string | null
}

interface Person {
  id?: number
  full_name: string
  nationality: string
  nrc_passport_no: string
  gender: string
  date_of_birth: string
  phone: string
  email: string
  residential_address: string
  companies?: CompanyLink[]
}

interface CompanyOption {
  id: number
  company_name: string
}

// The client confirmed these eight fields are the ONLY person fields.
// Shares + capital deliberately live on the company link, not the person.
const EMPTY_PERSON: Person = {
  full_name: "",
  nationality: "",
  nrc_passport_no: "",
  gender: "",
  date_of_birth: "",
  phone: "",
  email: "",
  residential_address: "",
}

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "director", label: "Director" },
  { value: "individual_shareholder", label: "Individual Shareholder" },
  { value: "both", label: "Both" },
]

const roleLabel = (role: string) =>
  ROLE_OPTIONS.find((r) => r.value === role)?.label || role || "—"

// ─── Shared brutalist class strings ─────────────────────────────────
const FOCUS =
  "focus:outline-none focus-visible:outline-none focus:ring-0 focus:border-[#007518] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#007518] focus-visible:ring-offset-[#feffd6]"
const INPUT = `w-full px-2.5 py-2 text-sm bg-[#fffff0] border-2 border-[#383832] text-[#383832] placeholder:text-[#383832]/40 transition-colors ${FOCUS}`
const BTN_DARK = `flex items-center gap-1.5 px-4 py-2 text-xs font-black uppercase tracking-wider bg-[#383832] text-[#feffd6] hover:bg-[#262622] disabled:opacity-40 disabled:cursor-not-allowed transition-colors ink-border stamp-press ${FOCUS}`
const BTN_GREEN = `flex items-center gap-1.5 px-4 py-2 text-xs font-black uppercase tracking-wider bg-[#007518] text-white hover:bg-[#005c13] disabled:opacity-40 disabled:cursor-not-allowed transition-colors ink-border stamp-press ${FOCUS}`
const BTN_PLAIN = `flex items-center gap-1.5 px-4 py-2 text-xs font-black uppercase tracking-wider bg-[#feffd6] text-[#383832] hover:bg-[#383832]/10 transition-colors ink-border stamp-press ${FOCUS}`
const ICON_BTN = `p-1.5 text-[#383832] hover:bg-[#383832]/10 transition-colors ${FOCUS}`

// ─── Error helpers ──────────────────────────────────────────────────
/** Pull a human message out of a failed response; special-cases 409 duplicates. */
// The API reports validation failures as HTTP 200 with {success: false, error}.
// Checking res.ok alone would treat a rejected write as a success.
async function assertSuccess(res: Response, fallback: string): Promise<void> {
  let body: any = null
  try {
    body = await res.clone().json()
  } catch {
    return
  }
  if (body && body.success === false) {
    throw new Error(body.error || body.detail || body.message || fallback)
  }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  let detail = ""
  try {
    const body = await res.json()
    detail = body?.detail || body?.error || body?.message || ""
    if (typeof detail !== "string") detail = JSON.stringify(detail)
  } catch {
    // Response had no JSON body — fall through to the status-based message.
  }
  if (res.status === 409) {
    return (
      detail ||
      "That NRC / passport number is already registered to another person. Open the existing record instead of creating a duplicate."
    )
  }
  return detail || `${fallback} (HTTP ${res.status})`
}

/** Endpoints are still settling; accept the common envelope shapes. */
function unwrapList<T>(body: any, ...keys: string[]): T[] {
  if (Array.isArray(body)) return body as T[]
  for (const key of keys) {
    if (Array.isArray(body?.[key])) return body[key] as T[]
  }
  if (Array.isArray(body?.data)) return body.data as T[]
  return []
}

function unwrapOne<T>(body: any, ...keys: string[]): T | null {
  if (!body || typeof body !== "object") return null
  for (const key of keys) {
    if (body[key] && typeof body[key] === "object") return body[key] as T
  }
  if (body.data && typeof body.data === "object") return body.data as T
  if (body.id !== undefined) return body as T
  return null
}

/** DATE columns reject "". Send null instead. */
const dateOrNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null)

/** <input type="date"> needs YYYY-MM-DD, not an ISO timestamp. */
const toDateInput = (v: string | null | undefined) =>
  v ? String(v).slice(0, 10) : ""

const formatDate = (v: string | null | undefined) => {
  if (!v) return "—"
  const d = new Date(v)
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

// ─── Reusable field ─────────────────────────────────────────────────
function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder = "",
  wide = false,
  required = false,
  hint = "",
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  wide?: boolean
  required?: boolean
  hint?: string
}) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <label className="block mb-1">
        <span className="tag-label">
          {label}
          {required && " *"}
        </span>
      </label>
      <input
        type={type}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INPUT}
      />
      {hint && <p className="mt-1 text-[10px] text-[#383832]/60 uppercase tracking-wide">{hint}</p>}
    </div>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
  wide = false,
  hint = "",
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  wide?: boolean
  hint?: string
}) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <label className="block mb-1">
        <span className="tag-label">{label}</span>
      </label>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)} className={INPUT}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1 text-[10px] text-[#383832]/60 uppercase tracking-wide">{hint}</p>}
    </div>
  )
}

/** Destructive actions are armed first, then confirmed — same guard rail as Companies. */
function ConfirmDelete({
  armed,
  onArm,
  onConfirm,
  onCancel,
  label,
  compact = false,
}: {
  armed: boolean
  onArm: () => void
  onConfirm: () => void
  onCancel: () => void
  label: string
  compact?: boolean
}) {
  if (!armed) {
    return (
      <button
        onClick={onArm}
        title={label}
        aria-label={label}
        className={compact ? `${ICON_BTN} hover:text-[#be2d06]` : `${BTN_PLAIN} text-[#be2d06]`}
      >
        <Trash2 className="w-3.5 h-3.5" />
        {!compact && <span>Delete</span>}
      </button>
    )
  }
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onConfirm}
        autoFocus
        className={`flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider bg-[#be2d06] text-white hover:bg-[#9c2505] transition-colors ink-border stamp-press ${FOCUS}`}
      >
        <Check className="w-3 h-3" /> Confirm
      </button>
      <button onClick={onCancel} aria-label="Cancel delete" className={ICON_BTN}>
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────
type View = "list" | "form" | "detail"

export default function PeoplePage() {
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [view, setView] = useState<View>("list")

  const [formData, setFormData] = useState<Person>({ ...EMPTY_PERSON })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const [detailPerson, setDetailPerson] = useState<Person | null>(null)
  const [links, setLinks] = useState<CompanyLink[]>([])
  const [linksLoading, setLinksLoading] = useState(false)
  const [companies, setCompanies] = useState<CompanyOption[]>([])

  const [showLinkForm, setShowLinkForm] = useState(false)
  const [linkDraft, setLinkDraft] = useState<CompanyLink>({
    company_id: 0,
    role: "director",
    number_of_shares: "",
    capital_amount: "",
    appointed_date: "",
  })
  const [linking, setLinking] = useState(false)

  const [armedDeleteId, setArmedDeleteId] = useState<number | null>(null)
  const [armedUnlink, setArmedUnlink] = useState<string | null>(null)

  // ── Load people ──
  const fetchPeople = useCallback(async () => {
    setLoadError("")
    try {
      const res = await authFetch(apiClient.getPeople())
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to load people"))
      await assertSuccess(res, "Failed to load people")
      const body = await res.json()
      const rows = unwrapList<Person>(body, "people")

      // If the list endpoint does not embed links, pull them so the table
      // can still render the Linked Companies column.
      const needsLinks = rows.length > 0 && rows.every((p) => p.companies === undefined)
      if (needsLinks) {
        const withLinks = await Promise.all(
          rows.map(async (p) => {
            if (!p.id) return p
            try {
              const lr = await authFetch(apiClient.getPersonCompanies(p.id))
              if (!lr.ok) return p
              const lb = await lr.json()
              return { ...p, companies: unwrapList<CompanyLink>(lb, "companies", "links") }
            } catch (e) {
              console.error("Person links load error:", e)
              return p
            }
          })
        )
        setPeople(withLinks)
      } else {
        setPeople(rows)
      }
    } catch (e: any) {
      console.error("People load error:", e)
      const msg = e?.message || "Failed to load people"
      setLoadError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Load companies (for the link picker) ──
  const fetchCompanies = useCallback(async () => {
    try {
      const res = await authFetch(apiClient.getDashboardData())
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to load companies"))
      await assertSuccess(res, "Failed to load companies")
      const body = await res.json()
      const rows = unwrapList<any>(body, "companies")
      setCompanies(
        rows
          .filter((c) => c?.id)
          .map((c) => ({ id: Number(c.id), company_name: c.company_name || c.company_name_english || `Company #${c.id}` }))
      )
    } catch (e: any) {
      console.error("Companies load error:", e)
      toast.error(e?.message || "Failed to load companies")
    }
  }, [])

  useEffect(() => {
    fetchPeople()
    fetchCompanies()
  }, [fetchPeople, fetchCompanies])

  // ── Create / edit ──
  const openCreate = () => {
    setFormData({ ...EMPTY_PERSON })
    setEditingId(null)
    setView("form")
  }

  const openEdit = (person: Person) => {
    setFormData({
      ...EMPTY_PERSON,
      ...person,
      date_of_birth: toDateInput(person.date_of_birth),
    })
    setEditingId(person.id ?? null)
    setView("form")
  }

  const handleSave = async () => {
    if (!formData.full_name.trim()) {
      toast.error("Full name is required")
      return
    }
    setSaving(true)
    try {
      const payload = {
        full_name: formData.full_name.trim(),
        nationality: formData.nationality?.trim() || "",
        nrc_passport_no: formData.nrc_passport_no?.trim() || "",
        gender: formData.gender || "",
        date_of_birth: dateOrNull(formData.date_of_birth),
        phone: formData.phone?.trim() || "",
        email: formData.email?.trim() || "",
        residential_address: formData.residential_address?.trim() || "",
      }
      const url = editingId ? apiClient.updatePerson(editingId) : apiClient.addPerson()
      const res = await authFetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to save person"))
      await assertSuccess(res, "Failed to save person")
      toast.success(`"${payload.full_name}" ${editingId ? "updated" : "added"}`)
      await fetchPeople()
      setView("list")
      setEditingId(null)
      setFormData({ ...EMPTY_PERSON })
    } catch (e: any) {
      console.error("Save person error:", e)
      toast.error(e?.message || "Failed to save person")
    } finally {
      setSaving(false)
    }
  }

  // ── Detail + links ──
  const loadLinks = useCallback(async (personId: number) => {
    setLinksLoading(true)
    try {
      const res = await authFetch(apiClient.getPersonCompanies(personId))
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to load company links"))
      await assertSuccess(res, "Failed to load company links")
      const body = await res.json()
      setLinks(unwrapList<CompanyLink>(body, "companies", "links"))
    } catch (e: any) {
      console.error("Links load error:", e)
      toast.error(e?.message || "Failed to load company links")
      setLinks([])
    } finally {
      setLinksLoading(false)
    }
  }, [])

  const openDetail = async (person: Person) => {
    setDetailPerson(person)
    setLinks([])
    setShowLinkForm(false)
    setArmedUnlink(null)
    setView("detail")
    if (!person.id) return
    try {
      const res = await authFetch(apiClient.getPerson(person.id))
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to load person"))
      await assertSuccess(res, "Failed to load person")
      const body = await res.json()
      const full = unwrapOne<Person>(body, "person")
      if (full) setDetailPerson({ ...person, ...full })
    } catch (e: any) {
      console.error("Person load error:", e)
      toast.error(e?.message || "Failed to load person")
    }
    await loadLinks(person.id)
  }

  const handleLink = async () => {
    if (!detailPerson?.id) return
    if (!linkDraft.company_id) {
      toast.error("Choose a company to link")
      return
    }
    setLinking(true)
    try {
      const res = await authFetch(apiClient.linkCompanyPerson(linkDraft.company_id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          person_id: detailPerson.id,
          role: linkDraft.role,
          number_of_shares: linkDraft.number_of_shares || "",
          capital_amount: linkDraft.capital_amount || "",
          appointed_date: dateOrNull(linkDraft.appointed_date),
        }),
      })
      if (!res.ok) {
        // The (company, person, role) index is unique — a repeat link also 409s.
        if (res.status === 409) {
          let detail = ""
          try {
            const b = await res.json()
            detail = b?.detail || b?.error || ""
          } catch {
            // no JSON body
          }
          throw new Error(detail || "This person is already linked to that company with that role.")
        }
        throw new Error(await errorMessage(res, "Failed to link company"))
      }
      toast.success("Company linked")
      setShowLinkForm(false)
      setLinkDraft({ company_id: 0, role: "director", number_of_shares: "", capital_amount: "", appointed_date: "" })
      await loadLinks(detailPerson.id)
      await fetchPeople()
    } catch (e: any) {
      console.error("Link error:", e)
      toast.error(e?.message || "Failed to link company")
    } finally {
      setLinking(false)
    }
  }

  const handleUnlink = async (link: CompanyLink) => {
    if (!detailPerson?.id) return
    try {
      const res = await authFetch(apiClient.unlinkCompanyPerson(link.company_id, detailPerson.id), {
        method: "DELETE",
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to unlink company"))
      await assertSuccess(res, "Failed to unlink company")
      toast.success("Company unlinked")
      setArmedUnlink(null)
      await loadLinks(detailPerson.id)
      await fetchPeople()
    } catch (e: any) {
      console.error("Unlink error:", e)
      toast.error(e?.message || "Failed to unlink company")
    }
  }

  // ── Delete ──
  const handleDelete = async (person: Person) => {
    if (!person.id) return
    try {
      const res = await authFetch(apiClient.deletePerson(person.id), { method: "DELETE" })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to delete person"))
      await assertSuccess(res, "Failed to delete person")
      toast.success(`"${person.full_name}" deleted`)
      setArmedDeleteId(null)
      await fetchPeople()
      if (detailPerson?.id === person.id) {
        setDetailPerson(null)
        setView("list")
      }
    } catch (e: any) {
      console.error("Delete person error:", e)
      toast.error(e?.message || "Failed to delete person")
    }
  }

  const backToList = () => {
    setView("list")
    setDetailPerson(null)
    setArmedDeleteId(null)
    setArmedUnlink(null)
  }

  const term = searchTerm.trim().toLowerCase()
  const filtered = term
    ? people.filter(
        (p) =>
          (p.full_name || "").toLowerCase().includes(term) ||
          (p.nrc_passport_no || "").toLowerCase().includes(term)
      )
    : people

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[#f5f5e8]">
        <Loader2 className="w-8 h-8 animate-spin text-[#007518]" />
      </div>
    )
  }

  // ── Add / Edit form ──
  if (view === "form") {
    return (
      <div className="flex flex-col h-full bg-[#f5f5e8] font-brutalist">
        <div className="flex items-center gap-3 p-4 border-b-[3px] border-[#383832] bg-[#feffd6]">
          <button onClick={backToList} aria-label="Back to people list" className={ICON_BTN}>
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-black uppercase tracking-wider text-[#383832]">
            {editingId ? "Edit Person" : "Add Person"}
          </h1>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto bg-[#fffff0] ink-border stamp-shadow p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                label="Full Name"
                value={formData.full_name}
                onChange={(v) => setFormData({ ...formData, full_name: v })}
                required
                wide
                placeholder="As it appears on the NRC or passport"
              />
              <Field
                label="NRC / Passport No."
                value={formData.nrc_passport_no}
                onChange={(v) => setFormData({ ...formData, nrc_passport_no: v })}
                placeholder="e.g. 12/ABC(N)123456"
                hint="Must be unique across the register"
              />
              <Field
                label="Nationality"
                value={formData.nationality}
                onChange={(v) => setFormData({ ...formData, nationality: v })}
                placeholder="e.g. Myanmar"
              />
              <SelectField
                label="Gender"
                value={formData.gender}
                onChange={(v) => setFormData({ ...formData, gender: v })}
                options={[
                  { value: "", label: "— Not specified —" },
                  { value: "Male", label: "Male" },
                  { value: "Female", label: "Female" },
                  { value: "Other", label: "Other" },
                ]}
              />
              <Field
                label="Date of Birth"
                value={formData.date_of_birth}
                onChange={(v) => setFormData({ ...formData, date_of_birth: v })}
                type="date"
                hint="Optional"
              />
              <Field
                label="Phone"
                value={formData.phone}
                onChange={(v) => setFormData({ ...formData, phone: v })}
                placeholder="e.g. +95 9 123 456 789"
              />
              <Field
                label="Email"
                value={formData.email}
                onChange={(v) => setFormData({ ...formData, email: v })}
                type="email"
                placeholder="name@example.com"
              />
              <Field
                label="Residential Address"
                value={formData.residential_address}
                onChange={(v) => setFormData({ ...formData, residential_address: v })}
                wide
                placeholder="Full residential address"
              />
            </div>

            <div className="mt-6 p-3 bg-[#feffd6] border-l-4 border-[#007518]">
              <p className="text-[11px] font-bold uppercase tracking-wide text-[#383832]">
                Shares and capital are not person fields
              </p>
              <p className="mt-1 text-[11px] text-[#383832]/70">
                A person holds shares <em>in a company</em>. Record share count and capital on the company
                link, from the person&apos;s detail page.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t-[3px] border-[#383832] bg-[#feffd6]">
          <button onClick={backToList} className={BTN_PLAIN}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || !formData.full_name.trim()} className={BTN_GREEN}>
            <Check className="w-3.5 h-3.5" />
            {saving ? "Saving..." : editingId ? "Update Person" : "Save Person"}
          </button>
        </div>
      </div>
    )
  }

  // ── Detail ──
  if (view === "detail" && detailPerson) {
    const p = detailPerson
    return (
      <div className="flex flex-col h-full bg-[#f5f5e8] font-brutalist">
        <div className="flex items-center justify-between gap-3 p-4 border-b-[3px] border-[#383832] bg-[#feffd6]">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={backToList} aria-label="Back to people list" className={ICON_BTN}>
              <ArrowLeft className="w-4 h-4" />
            </button>
            <h1 className="text-lg font-black uppercase tracking-wider text-[#383832] truncate">
              {p.full_name}
            </h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => openEdit(p)} className={BTN_DARK}>
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
            <ConfirmDelete
              armed={armedDeleteId === p.id}
              onArm={() => setArmedDeleteId(p.id ?? null)}
              onConfirm={() => handleDelete(p)}
              onCancel={() => setArmedDeleteId(null)}
              label={`Delete ${p.full_name}`}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Person record */}
          <div className="bg-[#fffff0] ink-border stamp-shadow p-5">
            <div className="flex items-center gap-2 mb-4">
              <Contact className="w-4 h-4 text-[#007518]" />
              <span className="text-[11px] font-black uppercase tracking-wider text-[#383832]">
                Person Record
              </span>
            </div>
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                ["Full Name", p.full_name],
                ["NRC / Passport", p.nrc_passport_no],
                ["Nationality", p.nationality],
                ["Gender", p.gender],
                ["Date of Birth", p.date_of_birth ? formatDate(p.date_of_birth) : ""],
                ["Phone", p.phone],
                ["Email", p.email],
                ["Residential Address", p.residential_address],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dt className="mb-1">
                    <span className="tag-label">{label}</span>
                  </dt>
                  <dd className="text-sm text-[#383832] break-words">{(value as string) || "—"}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Company links */}
          <div className="bg-[#fffff0] ink-border stamp-shadow p-5">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <Link2 className="w-4 h-4 text-[#007518]" />
                <span className="text-[11px] font-black uppercase tracking-wider text-[#383832]">
                  Company Links ({links.length})
                </span>
              </div>
              <button onClick={() => setShowLinkForm((s) => !s)} className={BTN_DARK}>
                <Plus className="w-3.5 h-3.5" /> {showLinkForm ? "Close" : "Link Company"}
              </button>
            </div>

            <div className="mb-4 p-3 bg-[#feffd6] border-l-4 border-[#007518]">
              <p className="text-[11px] text-[#383832]/80">
                <strong className="uppercase tracking-wide">Shares and capital belong to the link.</strong>{" "}
                The same person can hold different shareholdings in different companies, so those numbers are
                recorded here — never on the person record above.
              </p>
            </div>

            {showLinkForm && (
              <div className="mb-4 p-4 bg-[#feffd6] ink-border">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <SelectField
                    label="Company"
                    value={linkDraft.company_id ? String(linkDraft.company_id) : ""}
                    onChange={(v) => setLinkDraft({ ...linkDraft, company_id: Number(v) || 0 })}
                    options={[
                      { value: "", label: companies.length ? "— Choose a company —" : "No companies yet" },
                      ...companies.map((c) => ({ value: String(c.id), label: c.company_name })),
                    ]}
                    wide
                  />
                  <SelectField
                    label="Role"
                    value={linkDraft.role}
                    onChange={(v) => setLinkDraft({ ...linkDraft, role: v as Role })}
                    options={ROLE_OPTIONS}
                  />
                  <Field
                    label="Appointed Date"
                    value={toDateInput(linkDraft.appointed_date)}
                    onChange={(v) => setLinkDraft({ ...linkDraft, appointed_date: v })}
                    type="date"
                  />
                  <Field
                    label="Number of Shares"
                    value={linkDraft.number_of_shares || ""}
                    onChange={(v) => setLinkDraft({ ...linkDraft, number_of_shares: v })}
                    placeholder="e.g. 10,000"
                    hint="Held in this company only"
                  />
                  <Field
                    label="Capital Amount"
                    value={linkDraft.capital_amount || ""}
                    onChange={(v) => setLinkDraft({ ...linkDraft, capital_amount: v })}
                    placeholder="e.g. 10,000,000 MMK"
                    hint="Held in this company only"
                  />
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={() => setShowLinkForm(false)} className={BTN_PLAIN}>
                    Cancel
                  </button>
                  <button onClick={handleLink} disabled={linking || !linkDraft.company_id} className={BTN_GREEN}>
                    <Check className="w-3.5 h-3.5" /> {linking ? "Linking..." : "Link Company"}
                  </button>
                </div>
              </div>
            )}

            {linksLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-[#383832]/70">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading links...
              </div>
            ) : links.length === 0 ? (
              <div className="py-8 text-center">
                <Building className="w-7 h-7 mx-auto text-[#383832]/30" />
                <p className="mt-2 text-sm font-bold uppercase tracking-wide text-[#383832]">
                  Not linked to any company
                </p>
                <p className="mt-1 text-xs text-[#383832]/70">
                  Link this person to a company to record their role, shareholding and appointment date.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {links.map((l, i) => {
                  const key = `${l.company_id}-${l.role}-${i}`
                  return (
                    <div key={key} className="p-4 bg-[#feffd6] ink-border">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-[#383832] truncate">
                            {l.company_name ||
                              companies.find((c) => c.id === l.company_id)?.company_name ||
                              `Company #${l.company_id}`}
                          </p>
                          <span className="tag-label mt-1">{roleLabel(l.role)}</span>
                        </div>
                        <ConfirmDelete
                          compact
                          armed={armedUnlink === key}
                          onArm={() => setArmedUnlink(key)}
                          onConfirm={() => handleUnlink(l)}
                          onCancel={() => setArmedUnlink(null)}
                          label="Unlink company"
                        />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 pt-3 border-t-2 border-[#383832]/20">
                        <div>
                          <span className="tag-label">Shares</span>
                          <p className="mt-1 text-sm text-[#383832]">{l.number_of_shares || "—"}</p>
                        </div>
                        <div>
                          <span className="tag-label">Capital</span>
                          <p className="mt-1 text-sm text-[#383832]">{l.capital_amount || "—"}</p>
                        </div>
                        <div>
                          <span className="tag-label">Appointed</span>
                          <p className="mt-1 text-sm text-[#383832]">{formatDate(l.appointed_date)}</p>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── List ──
  return (
    <div className="flex flex-col h-full bg-[#f5f5e8] font-brutalist">
      <div className="flex items-center justify-between gap-3 p-4 border-b-[3px] border-[#383832] bg-[#feffd6]">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-black uppercase tracking-wider text-[#383832]">People</h1>
          <span className="tag-label">{people.length} on register</span>
        </div>
        <button onClick={openCreate} className={BTN_GREEN}>
          <Plus className="w-4 h-4" /> Add Person
        </button>
      </div>

      {loadError && (
        <div className="px-4 py-3 border-b-2 border-[#be2d06] bg-[#be2d06]/10 text-xs font-bold uppercase tracking-wide text-[#be2d06]">
          {loadError}
        </div>
      )}

      <div className="p-4 border-b-[3px] border-[#383832] bg-[#feffd6]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#383832]/60 pointer-events-none" />
          <input
            type="search"
            aria-label="Search people by name or NRC"
            placeholder="Search by name or NRC / passport..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={`${INPUT} pl-10`}
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {people.length === 0 ? (
          // First-run empty state — this is the first thing a new install sees.
          <div className="max-w-2xl mx-auto mt-6 bg-[#fffff0] ink-border stamp-shadow p-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[#383832] flex items-center justify-center shrink-0">
                <Contact className="w-5 h-5 text-[#feffd6]" />
              </div>
              <div>
                <h2 className="text-base font-black uppercase tracking-wider text-[#383832]">
                  The People Register is empty
                </h2>
                <p className="text-xs text-[#383832]/70">Nobody has been added yet.</p>
              </div>
            </div>

            <p className="mt-5 text-sm text-[#383832]/80">
              This register holds every individual who appears in your documents — directors, individual
              shareholders, and anyone who signs. Record a person <strong>once</strong>, then link them to as
              many companies as you need.
            </p>

            <div className="mt-5 space-y-3">
              {[
                ["1", "Add the person", "Eight fields: name, nationality, NRC / passport, gender, date of birth, phone, email and address."],
                ["2", "Link them to a company", "Pick a role — Director, Individual Shareholder, or Both."],
                ["3", "Record shares on the link", "Shares, capital and appointed date belong to the company link, not to the person."],
              ].map(([n, title, body]) => (
                <div key={n} className="flex gap-3 p-3 bg-[#feffd6] ink-border">
                  <span className="w-6 h-6 shrink-0 bg-[#007518] text-white text-xs font-black flex items-center justify-center">
                    {n}
                  </span>
                  <div>
                    <p className="text-xs font-black uppercase tracking-wide text-[#383832]">{title}</p>
                    <p className="mt-0.5 text-xs text-[#383832]/70">{body}</p>
                  </div>
                </div>
              ))}
            </div>

            <button onClick={openCreate} className={`${BTN_GREEN} mt-6`}>
              <UserPlus className="w-4 h-4" /> Add the first person
            </button>
          </div>
        ) : (
          <>
            <div className="bg-[#fffff0] ink-border stamp-shadow overflow-x-auto">
              <table className="w-full">
                <thead className="bg-[#383832]">
                  <tr className="text-left">
                    {["Full Name", "NRC / Passport", "Nationality", "Gender", "Date of Birth", "Phone", "Linked Companies", ""].map(
                      (h, i) => (
                        <th
                          key={i}
                          className={`px-4 py-3 text-[10px] font-black uppercase tracking-wider text-[#feffd6] ${
                            i === 7 ? "text-right" : ""
                          }`}
                        >
                          {h || "Actions"}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-12 text-center">
                        <p className="text-sm font-bold uppercase tracking-wide text-[#383832]">
                          No match for &ldquo;{searchTerm}&rdquo;
                        </p>
                        <p className="mt-1 text-xs text-[#383832]/70">
                          Search matches full name and NRC / passport number.
                        </p>
                        <button onClick={() => setSearchTerm("")} className={`${BTN_PLAIN} mx-auto mt-3`}>
                          Clear search
                        </button>
                      </td>
                    </tr>
                  ) : (
                    filtered.map((p) => (
                      <tr
                        key={p.id}
                        tabIndex={0}
                        role="button"
                        aria-label={`Open ${p.full_name}`}
                        onClick={() => openDetail(p)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            openDetail(p)
                          }
                        }}
                        className={`border-t-2 border-[#383832]/20 cursor-pointer hover:bg-[#383832]/[0.06] transition-colors ${FOCUS}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 bg-[#383832] flex items-center justify-center shrink-0">
                              <span className="text-[#feffd6] text-[11px] font-black">
                                {(p.full_name || "?").charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <span className="text-sm font-bold text-[#383832]">{p.full_name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-[#383832]/80 font-mono">
                          {p.nrc_passport_no || "—"}
                        </td>
                        <td className="px-4 py-3 text-sm text-[#383832]/80">{p.nationality || "—"}</td>
                        <td className="px-4 py-3 text-sm text-[#383832]/80">{p.gender || "—"}</td>
                        <td className="px-4 py-3 text-sm text-[#383832]/80 whitespace-nowrap">
                          {formatDate(p.date_of_birth)}
                        </td>
                        <td className="px-4 py-3 text-sm text-[#383832]/80 whitespace-nowrap">
                          {p.phone || "—"}
                        </td>
                        <td className="px-4 py-3">
                          {p.companies && p.companies.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {p.companies.map((l, i) => (
                                <span key={`${l.company_id}-${l.role}-${i}`} className="tag-label">
                                  {(l.company_name ||
                                    companies.find((c) => c.id === l.company_id)?.company_name ||
                                    `#${l.company_id}`) +
                                    " · " +
                                    roleLabel(l.role)}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-sm text-[#383832]/50">Not linked</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => openEdit(p)}
                              title={`Edit ${p.full_name}`}
                              aria-label={`Edit ${p.full_name}`}
                              className={`${ICON_BTN} hover:text-[#007518]`}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <ConfirmDelete
                              compact
                              armed={armedDeleteId === p.id}
                              onArm={() => setArmedDeleteId(p.id ?? null)}
                              onConfirm={() => handleDelete(p)}
                              onCancel={() => setArmedDeleteId(null)}
                              label={`Delete ${p.full_name}`}
                            />
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-[#383832]/60">
              Showing {filtered.length} of {people.length} people
            </p>
          </>
        )}
      </div>
    </div>
  )
}
