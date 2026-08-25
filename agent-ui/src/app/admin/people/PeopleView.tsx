"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowLeft,
  Building,
  Check,
  Contact,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserMinus,
  UserPlus,
} from "lucide-react"
import apiClient, { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import {
  Badge,
  Button,
  Card,
  type Column,
  ConfirmButton,
  DataTable,
  DetailList,
  EmptyState,
  FormGrid,
  IconButton,
  LoadingScreen,
  Modal,
  Notice,
  Page,
  PageBody,
  PageHeader,
  SearchInput,
  SelectField,
  StatRow,
  StatTile,
  TextField,
  Toolbar,
  assertSuccess,
  dateOrNull,
  dateSort,
  errorMessage,
  formatDate,
  toDateInput,
  unwrapList,
  unwrapOne,
} from "@/components/ui/kit"

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
  // Cessation is a property of the SEAT, not of the person: the same director
  // leaves two boards on two different days for two different reasons. These sit
  // beside the resigned_date they annotate. `cessation_recorded_by` is filled by
  // the server from the admin's JWT and is read-only here — see
  // db/migration_025_people_cessation.sql.
  cessation_reason?: string | null
  cessation_recorded_by?: string | null
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
  business_occupation: string
  country_of_residence: string
  father_name: string
  companies?: CompanyLink[]
}

/** One recorded cessation: which seat was vacated, when, and why. The recorder
 *  is not here — the server takes it from the acting admin's session. */
interface CessationDraft {
  link_key: string
  cessation_date: string
  cessation_reason: string
}

interface CompanyOption {
  id: number
  company_name: string
}

// The client's agreed eight fields, plus two added later: business occupation
// (DICA publishes it per director, so the sync would otherwise discard it) and
// country of residence (hand-entered; consent forms treat resident and
// non-resident directors differently).
// Shares, capital and appointment dates deliberately live on the company link,
// not the person — the same director joins two boards on two different dates.
const EMPTY_PERSON: Person = {
  full_name: "",
  nationality: "",
  nrc_passport_no: "",
  gender: "",
  date_of_birth: "",
  phone: "",
  email: "",
  residential_address: "",
  business_occupation: "",
  country_of_residence: "",
  father_name: "",
}

const EMPTY_CESSATION: CessationDraft = {
  link_key: "",
  cessation_date: "",
  cessation_reason: "",
}

// The events the firm actually files for. Free text is kept as the last option
// because "removed under s.156" and "died in office" are not the same filing and
// a fixed list would push both into "Other" with no way to say which.
const CESSATION_REASONS = [
  "Resigned",
  "Removed by shareholders' resolution",
  "Term expired",
  "Disqualified",
  "Deceased",
  "Other",
]

/** A link identifies a board seat by (company, role) — the same pair the
 *  company_people unique index and its UPSERT use. */
const linkKey = (l: CompanyLink) => `${l.company_id}::${l.role}`

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "director", label: "Director" },
  { value: "individual_shareholder", label: "Individual Shareholder" },
  { value: "both", label: "Both" },
]

const roleLabel = (role: string) => ROLE_OPTIONS.find((r) => r.value === role)?.label || role || "—"

const roleTone = (role: string) =>
  role === "director" ? "info" : role === "both" ? "accent" : "neutral"

/** A person missing contact details cannot be used to fill a document cleanly. */
const missingFields = (p: Person) =>
  [
    !p.nrc_passport_no && "NRC / passport",
    !p.nationality && "nationality",
    !p.residential_address && "address",
  ].filter(Boolean) as string[]

// ─── Page ───────────────────────────────────────────────────────────
type View = "list" | "detail"

export default function PeopleView() {
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [view, setView] = useState<View>("list")

  const [formOpen, setFormOpen] = useState(false)
  const [formData, setFormData] = useState<Person>({ ...EMPTY_PERSON })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const [detailPerson, setDetailPerson] = useState<Person | null>(null)
  const [links, setLinks] = useState<CompanyLink[]>([])
  const [linksLoading, setLinksLoading] = useState(false)
  const [companies, setCompanies] = useState<CompanyOption[]>([])

  const [linkOpen, setLinkOpen] = useState(false)
  const [linkDraft, setLinkDraft] = useState<CompanyLink>({
    company_id: 0,
    role: "director",
    number_of_shares: "",
    capital_amount: "",
    appointed_date: "",
  })
  const [linking, setLinking] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const [cessationOpen, setCessationOpen] = useState(false)
  const [cessationDraft, setCessationDraft] = useState<CessationDraft>({ ...EMPTY_CESSATION })
  const [recordingCessation, setRecordingCessation] = useState(false)

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

  // ── Backfill the register from the stored company filings ──
  // New companies sync on save; this covers records saved before the sync
  // existed. Idempotent, so re-running it is always safe.
  const syncFromCompanies = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await authFetch(apiClient.syncPeopleFromCompanies(), { method: "POST" })
      if (!res.ok) throw new Error(await errorMessage(res, "Sync failed"))
      const body = await res.json()
      if (!body?.success) throw new Error(body?.error || "Sync failed")

      const { created = 0, updated = 0, linked = 0, companies: scanned = 0 } = body
      if (created === 0 && updated === 0) {
        toast.success(`Register already matches ${scanned} ${scanned === 1 ? "company" : "companies"}`)
      } else {
        toast.success(
          `${created} added, ${updated} updated, ${linked} company ${linked === 1 ? "link" : "links"} from ${scanned} ${scanned === 1 ? "company" : "companies"}`
        )
      }
      await fetchPeople()
    } catch (e: any) {
      console.error("People sync error:", e)
      toast.error(e?.message || "Sync failed")
    } finally {
      setSyncing(false)
    }
  }, [fetchPeople])

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
          .map((c) => ({
            id: Number(c.id),
            company_name: c.company_name || c.company_name_english || `Company #${c.id}`,
          }))
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
    setFormOpen(true)
  }

  const openEdit = (person: Person) => {
    setFormData({ ...EMPTY_PERSON, ...person, date_of_birth: toDateInput(person.date_of_birth) })
    setEditingId(person.id ?? null)
    setFormOpen(true)
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
        business_occupation: formData.business_occupation?.trim() || "",
        country_of_residence: formData.country_of_residence?.trim() || "",
        father_name: formData.father_name?.trim() || "",
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
      setFormOpen(false)
      setEditingId(null)
      setFormData({ ...EMPTY_PERSON })
      // Keep the detail view in step when the edit came from there.
      if (detailPerson?.id && detailPerson.id === editingId) {
        setDetailPerson({ ...detailPerson, ...payload, date_of_birth: payload.date_of_birth || "" })
      }
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
    setLinkOpen(false)
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
          throw new Error(
            await errorMessage(res, "This person is already linked to that company with that role.")
          )
        }
        throw new Error(await errorMessage(res, "Failed to link company"))
      }
      await assertSuccess(res, "Failed to link company")
      toast.success("Company linked")
      setLinkOpen(false)
      setLinkDraft({
        company_id: 0,
        role: "director",
        number_of_shares: "",
        capital_amount: "",
        appointed_date: "",
      })
      await loadLinks(detailPerson.id)
      await fetchPeople()
    } catch (e: any) {
      console.error("Link error:", e)
      toast.error(e?.message || "Failed to link company")
    } finally {
      setLinking(false)
    }
  }

  // ── Record a cessation ──
  // Date, reason and recorder all describe ONE BOARD SEAT, so this is a single
  // write to the link — the SAME endpoint as "Link company", which UPSERTs on
  // (company_id, person_id, role). A person on two boards therefore carries two
  // independent cessations; see db/migration_025_people_cessation.sql for why
  // the reason is not a person column.
  //
  // ★ That UPSERT sets every column from EXCLUDED, so any field left out of the
  // body is written as NULL. Shares, capital, share class and the appointed date
  // are therefore echoed back from the link we are amending — omitting them
  // would quietly erase the shareholding while recording a resignation. Measured:
  // a body carrying only resigned_date blanked all four.
  //
  // `cessation_recorded_by` is deliberately NOT in the body. The server takes it
  // from the acting admin's JWT. `ls_user.email` is in localStorage and would
  // have been easy to send, but a recorder the client chooses is a claim, not an
  // audit trail — and this row is what a regulator would be shown.
  const openCessation = () => {
    const open = links.filter((l) => !l.resigned_date)
    setCessationDraft({
      ...EMPTY_CESSATION,
      link_key: open.length === 1 ? linkKey(open[0]) : "",
    })
    setCessationOpen(true)
  }

  const handleRecordCessation = async () => {
    if (!detailPerson?.id) return
    const link = links.find((l) => linkKey(l) === cessationDraft.link_key)
    if (!link) {
      toast.error("Choose the company this person has ceased to act for")
      return
    }
    if (!cessationDraft.cessation_date) {
      toast.error("A cessation date is required")
      return
    }
    setRecordingCessation(true)
    try {
      const res = await authFetch(apiClient.linkCompanyPerson(link.company_id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          person_id: detailPerson.id,
          role: link.role,
          number_of_shares: link.number_of_shares || "",
          capital_amount: link.capital_amount || "",
          share_class: link.share_class || "",
          appointed_date: dateOrNull(link.appointed_date),
          resigned_date: dateOrNull(cessationDraft.cessation_date),
          cessation_reason: cessationDraft.cessation_reason.trim(),
        }),
      })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to record the cessation"))
      await assertSuccess(res, "Failed to record the cessation")

      toast.success(`Cessation recorded for ${companyName(link)}`)
      setCessationOpen(false)
      setCessationDraft({ ...EMPTY_CESSATION })
      // Reload rather than patching state locally: the recorder is decided by
      // the server, so the only way to show the real value is to read it back.
      await loadLinks(detailPerson.id)
      await fetchPeople()
    } catch (e: any) {
      console.error("Record cessation error:", e)
      toast.error(e?.message || "Failed to record the cessation")
    } finally {
      setRecordingCessation(false)
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
  }

  const term = searchTerm.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      term
        ? people.filter(
            (p) =>
              (p.full_name || "").toLowerCase().includes(term) ||
              (p.nrc_passport_no || "").toLowerCase().includes(term)
          )
        : people,
    [people, term]
  )

  const stats = useMemo(() => {
    const linked = people.filter((p) => (p.companies?.length ?? 0) > 0).length
    const directors = people.filter((p) =>
      p.companies?.some((l) => l.role === "director" || l.role === "both")
    ).length
    const incomplete = people.filter((p) => missingFields(p).length > 0).length
    return { total: people.length, linked, directors, incomplete }
  }, [people])

  const companyName = useCallback(
    (l: CompanyLink) =>
      l.company_name || companies.find((c) => c.id === l.company_id)?.company_name || `Company #${l.company_id}`,
    [companies]
  )

  // ── The add / edit form, shared by both views ──
  const personForm = (
    <Modal
      open={formOpen}
      onOpenChange={setFormOpen}
      title={editingId ? "Edit person" : "Add person"}
      description="Eight fields describe a person. Shareholdings are recorded per company, on the link."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => setFormOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!formData.full_name.trim()}
            icon={<Check className="w-3.5 h-3.5" />}
          >
            {editingId ? "Update person" : "Save person"}
          </Button>
        </>
      }
    >
      <FormGrid>
        <TextField
          label="Full name"
          value={formData.full_name}
          onChange={(v) => setFormData({ ...formData, full_name: v })}
          required
          wide
          placeholder="As it appears on the NRC or passport"
        />
        <TextField
          label="NRC / passport no."
          value={formData.nrc_passport_no}
          onChange={(v) => setFormData({ ...formData, nrc_passport_no: v })}
          placeholder="12/ABC(N)123456"
          hint="Must be unique across the register"
          mono
        />
        <TextField
          label="Father's name"
          value={formData.father_name}
          onChange={(v) => setFormData({ ...formData, father_name: v })}
          placeholder="U Tin Maung"
        />
        <TextField
          label="Nationality"
          value={formData.nationality}
          onChange={(v) => setFormData({ ...formData, nationality: v })}
          placeholder="Myanmar"
        />
        <SelectField
          label="Gender"
          value={formData.gender}
          onChange={(v) => setFormData({ ...formData, gender: v })}
          options={[
            { value: "", label: "Not specified" },
            { value: "Male", label: "Male" },
            { value: "Female", label: "Female" },
            { value: "Other", label: "Other" },
          ]}
        />
        <TextField
          label="Date of birth"
          value={formData.date_of_birth}
          onChange={(v) => setFormData({ ...formData, date_of_birth: v })}
          type="date"
        />
        <TextField
          label="Phone"
          value={formData.phone}
          onChange={(v) => setFormData({ ...formData, phone: v })}
          placeholder="+95 9 123 456 789"
        />
        <TextField
          label="Email"
          value={formData.email}
          onChange={(v) => setFormData({ ...formData, email: v })}
          type="email"
          placeholder="name@example.com"
        />
        <TextField
          label="Business occupation"
          value={formData.business_occupation}
          onChange={(v) => setFormData({ ...formData, business_occupation: v })}
          placeholder="Company Director"
        />
        <TextField
          label="Country of residence"
          value={formData.country_of_residence}
          onChange={(v) => setFormData({ ...formData, country_of_residence: v })}
          placeholder="Myanmar"
        />
        <TextField
          label="Residential address"
          value={formData.residential_address}
          onChange={(v) => setFormData({ ...formData, residential_address: v })}
          wide
          placeholder="Full residential address"
        />
      </FormGrid>

      <div className="mt-4">
        <Notice title="Shares are not a person field">
          A person holds shares <em>in a company</em>. Record share count, capital and appointment date on the
          company link, from the person&apos;s detail page.
        </Notice>
      </div>
    </Modal>
  )

  if (loading) return <LoadingScreen label="Loading people" />

  // ── Detail ──
  if (view === "detail" && detailPerson) {
    const p = detailPerson
    const gaps = missingFields(p)
    return (
      <Page>
        <PageHeader
          back={
            <IconButton aria-label="Back to people" onClick={backToList} icon={<ArrowLeft className="w-4 h-4" />} />
          }
          title={p.full_name}
          meta={
            gaps.length > 0 ? (
              <Badge tone="warn" dot>
                {gaps.length} field{gaps.length > 1 ? "s" : ""} missing
              </Badge>
            ) : (
              <Badge tone="ok" dot>
                Complete
              </Badge>
            )
          }
          actions={
            <>
              <Button onClick={() => openEdit(p)} icon={<Pencil className="w-3.5 h-3.5" />}>
                Edit
              </Button>
              <ConfirmButton
                label={`Delete ${p.full_name}`}
                icon={<Trash2 className="w-3.5 h-3.5" />}
                onConfirm={() => handleDelete(p)}
              >
                Delete
              </ConfirmButton>
            </>
          }
        />

        <PageBody className="space-y-4">
          {gaps.length > 0 && (
            <Notice tone="warn" title="Incomplete record">
              Missing {gaps.join(", ")}. Documents that reference this person will fall back to a placeholder.
            </Notice>
          )}

          <Card title="Person record" meta={<Badge tone="neutral">11 fields</Badge>}>
            <DetailList
              items={[
                ["Full name", p.full_name],
                ["Father's name", p.father_name],
                ["NRC / passport", <span key="nrc" className="font-mono tabular-nums">{p.nrc_passport_no || "—"}</span>],
                ["Nationality", p.nationality],
                ["Gender", p.gender],
                ["Date of birth", p.date_of_birth ? formatDate(p.date_of_birth) : ""],
                ["Business occupation", p.business_occupation],
                ["Country of residence", p.country_of_residence],
                ["Phone", p.phone],
                ["Email", p.email],
                ["Residential address", p.residential_address],
              ]}
            />
          </Card>

          {/* Appointment and resignation dates are per-company, not per-person:
              the same director joins two boards on two different dates. Shown
              here read-only, sourced from the company links below. */}
          {/* Reason and recorder ride on the SAME row as the date they explain,
              because all three belong to one board seat. A person on two boards
              shows two independent lines here. */}
          {links.some(
            (l) => l.appointed_date || l.resigned_date || l.cessation_reason
          ) && (
            <Card title="Appointment history" meta={<Badge tone="neutral">{links.length}</Badge>}>
              <DetailList
                items={links.map((l) => [
                  l.company_name || `Company #${l.company_id}`,
                  [
                    roleLabel(l.role),
                    l.appointed_date ? `appointed ${formatDate(l.appointed_date)}` : null,
                    l.resigned_date ? `ceased ${formatDate(l.resigned_date)}` : null,
                    l.cessation_reason || null,
                    l.cessation_recorded_by ? `recorded by ${l.cessation_recorded_by}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ]) as [string, string][]}
              />
            </Card>
          )}

          <Card
            title="Company links"
            meta={<Badge tone="neutral">{links.length}</Badge>}
            actions={
              <>
                <Button
                  size="sm"
                  onClick={openCessation}
                  disabled={links.length === 0}
                  icon={<UserMinus className="w-3.5 h-3.5" />}
                  title={
                    links.length === 0
                      ? "Link this person to a company first"
                      : "Record the date this person stopped acting"
                  }
                >
                  Record cessation
                </Button>
                <Button variant="primary" size="sm" onClick={() => setLinkOpen(true)} icon={<Plus className="w-3.5 h-3.5" />}>
                  Link company
                </Button>
              </>
            }
            padded={false}
          >
            <div className="px-4 pt-3">
              <Notice title="Shares belong to the link">
                The same person can hold different shareholdings in different companies, so those numbers are
                recorded here — never on the person record above.
              </Notice>
            </div>

            <div className="p-4">
              <DataTable<CompanyLink>
                loading={linksLoading}
                rows={links}
                rowKey={(l, i) => `${l.company_id}-${l.role}-${i}`}
                empty={
                  <div className="py-2">
                    <Building className="w-6 h-6 mx-auto text-[var(--text-muted)]" />
                    <p className="mt-2 text-[length:var(--text-sm)] text-[var(--text)]">Not linked to any company</p>
                    <p className="mt-0.5 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                      Link this person to a company to record their role, shareholding and appointment date.
                    </p>
                  </div>
                }
                columns={[
                  {
                    key: "company",
                    header: "Company",
                    sortValue: (l) => companyName(l),
                    render: (l) => (
                      <span className="font-medium text-[var(--text)]">{companyName(l)}</span>
                    ),
                  },
                  {
                    key: "role",
                    header: "Role",
                    sortValue: (l) => l.role,
                    render: (l) => <Badge tone={roleTone(l.role)}>{roleLabel(l.role)}</Badge>,
                  },
                  {
                    key: "shares",
                    header: "Shares",
                    numeric: true,
                    render: (l) => l.number_of_shares || "—",
                  },
                  {
                    key: "capital",
                    header: "Capital",
                    numeric: true,
                    hideBelow: "sm",
                    render: (l) => l.capital_amount || "—",
                  },
                  {
                    key: "appointed",
                    header: "Appointed",
                    hideBelow: "md",
                    sortValue: (l) => dateSort(l.appointed_date),
                    render: (l) => formatDate(l.appointed_date),
                  },
                  {
                    key: "ceased",
                    header: "Ceased",
                    hideBelow: "md",
                    sortValue: (l) => dateSort(l.resigned_date),
                    render: (l) =>
                      l.resigned_date ? (
                        <Badge tone="warn">{formatDate(l.resigned_date)}</Badge>
                      ) : (
                        <Badge tone="ok">Acting</Badge>
                      ),
                  },
                  {
                    key: "actions",
                    header: "",
                    align: "right",
                    width: "1%",
                    stopClickPropagation: true,
                    render: (l) => (
                      <ConfirmButton
                        compact
                        label={`Unlink ${companyName(l)}`}
                        icon={<Trash2 className="w-3.5 h-3.5" />}
                        onConfirm={() => handleUnlink(l)}
                      />
                    ),
                  },
                ]}
              />
            </div>
          </Card>
        </PageBody>

        {personForm}

        <Modal
          open={linkOpen}
          onOpenChange={setLinkOpen}
          title="Link a company"
          description={`Record ${p.full_name}'s role and shareholding in one company.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setLinkOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleLink}
                loading={linking}
                disabled={!linkDraft.company_id}
                icon={<Link2 className="w-3.5 h-3.5" />}
              >
                Link company
              </Button>
            </>
          }
        >
          <FormGrid>
            <SelectField
              label="Company"
              wide
              value={linkDraft.company_id ? String(linkDraft.company_id) : ""}
              onChange={(v) => setLinkDraft({ ...linkDraft, company_id: Number(v) || 0 })}
              options={[
                { value: "", label: companies.length ? "Choose a company" : "No companies yet" },
                ...companies.map((c) => ({ value: String(c.id), label: c.company_name })),
              ]}
            />
            <SelectField
              label="Role"
              value={linkDraft.role}
              onChange={(v) => setLinkDraft({ ...linkDraft, role: v as Role })}
              options={ROLE_OPTIONS}
            />
            <TextField
              label="Appointed date"
              type="date"
              value={toDateInput(linkDraft.appointed_date)}
              onChange={(v) => setLinkDraft({ ...linkDraft, appointed_date: v })}
            />
            <TextField
              label="Number of shares"
              value={linkDraft.number_of_shares || ""}
              onChange={(v) => setLinkDraft({ ...linkDraft, number_of_shares: v })}
              placeholder="10,000"
              hint="Held in this company only"
              mono
            />
            <TextField
              label="Capital amount"
              value={linkDraft.capital_amount || ""}
              onChange={(v) => setLinkDraft({ ...linkDraft, capital_amount: v })}
              placeholder="10,000,000 MMK"
              hint="Held in this company only"
              mono
            />
          </FormGrid>
        </Modal>

        <Modal
          open={cessationOpen}
          onOpenChange={setCessationOpen}
          title="Record a cessation"
          description={`Record the date ${p.full_name} stopped acting, and on what authority.`}
          size="md"
          footer={
            <>
              <Button variant="ghost" onClick={() => setCessationOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleRecordCessation}
                loading={recordingCessation}
                disabled={!cessationDraft.link_key || !cessationDraft.cessation_date}
                icon={<UserMinus className="w-3.5 h-3.5" />}
              >
                Record cessation
              </Button>
            </>
          }
        >
          <FormGrid>
            <SelectField
              label="Company"
              wide
              value={cessationDraft.link_key}
              onChange={(v) => setCessationDraft({ ...cessationDraft, link_key: v })}
              options={[
                { value: "", label: "Choose the board seat being vacated" },
                ...links.map((l) => ({
                  value: linkKey(l),
                  label: `${companyName(l)} — ${roleLabel(l.role)}${
                    l.resigned_date ? ` (ceased ${formatDate(l.resigned_date)})` : ""
                  }`,
                })),
              ]}
            />
            <TextField
              label="Cessation date"
              type="date"
              required
              value={toDateInput(cessationDraft.cessation_date)}
              onChange={(v) => setCessationDraft({ ...cessationDraft, cessation_date: v })}
              hint="Recorded against this company only"
            />
            <SelectField
              label="Reason"
              wide
              value={cessationDraft.cessation_reason}
              onChange={(v) => setCessationDraft({ ...cessationDraft, cessation_reason: v })}
              options={[
                { value: "", label: "Not stated" },
                ...CESSATION_REASONS.map((r) => ({ value: r, label: r })),
              ]}
              hint="A resignation, a removal and a death are three different filings"
            />
          </FormGrid>

          <div className="mt-4">
            <Notice title="This takes effect immediately">
              From the cessation date the person pickers stop offering{" "}
              {p.full_name} for {"that company's"} documents, and a resolution can no longer
              be signed in their name. Only this board seat is affected — any other company{" "}
              {p.full_name} sits on is untouched. Your own account is recorded as the person
              who changed the register.
            </Notice>
          </div>
        </Modal>
      </Page>
    )
  }

  // ── List ──
  const columns: Column<Person>[] = [
    {
      key: "full_name",
      header: "Name",
      sortValue: (p) => p.full_name,
      render: (p) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-6 h-6 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] text-[length:var(--text-2xs)] font-semibold text-[var(--text-secondary)] rounded-[var(--radius-sm)]">
            {(p.full_name || "?").charAt(0).toUpperCase()}
          </span>
          <span className="font-medium text-[var(--text)] truncate">{p.full_name}</span>
        </div>
      ),
    },
    {
      key: "nrc_passport_no",
      header: "NRC / passport",
      sortValue: (p) => p.nrc_passport_no,
      render: (p) =>
        p.nrc_passport_no ? (
          <span className="font-mono tabular-nums">{p.nrc_passport_no}</span>
        ) : (
          <Badge tone="warn">Missing</Badge>
        ),
    },
    {
      key: "nationality",
      header: "Nationality",
      hideBelow: "lg",
      sortValue: (p) => p.nationality,
      render: (p) => p.nationality || "—",
    },
    {
      key: "date_of_birth",
      header: "Born",
      hideBelow: "lg",
      sortValue: (p) => dateSort(p.date_of_birth),
      render: (p) => <span className="tabular-nums whitespace-nowrap">{formatDate(p.date_of_birth)}</span>,
    },
    {
      key: "phone",
      header: "Phone",
      hideBelow: "md",
      render: (p) => <span className="tabular-nums whitespace-nowrap">{p.phone || "—"}</span>,
    },
    {
      key: "companies",
      header: "Linked companies",
      sortValue: (p) => p.companies?.length ?? 0,
      render: (p) =>
        p.companies && p.companies.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {p.companies.slice(0, 3).map((l, i) => (
              <Badge key={`${l.company_id}-${l.role}-${i}`} tone={roleTone(l.role)}>
                {companyName(l)}
              </Badge>
            ))}
            {p.companies.length > 3 && <Badge tone="neutral">+{p.companies.length - 3}</Badge>}
          </div>
        ) : (
          <span className="text-[var(--text-muted)]">Not linked</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "1%",
      stopClickPropagation: true,
      render: (p) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton
            aria-label={`Edit ${p.full_name}`}
            title="Edit"
            onClick={() => openEdit(p)}
            icon={<Pencil className="w-3.5 h-3.5" />}
          />
          <ConfirmButton
            compact
            label={`Delete ${p.full_name}`}
            icon={<Trash2 className="w-3.5 h-3.5" />}
            onConfirm={() => handleDelete(p)}
          />
        </div>
      ),
    },
  ]

  return (
    <Page>
      <PageHeader
        title="People"
        meta={<Badge tone="neutral">{people.length} on register</Badge>}
        description="Every individual who appears in a document — directors, individual shareholders and signatories. Record a person once, then link them to as many companies as you need."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={syncFromCompanies}
              disabled={syncing}
              icon={<RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />}
              title="Read directors and individual shareholders off every company filing"
            >
              {syncing ? "Syncing…" : "Sync from companies"}
            </Button>
            <Button variant="primary" onClick={openCreate} icon={<Plus className="w-4 h-4" />}>
              Add person
            </Button>
          </>
        }
      />

      {people.length > 0 && (
        <Toolbar>
          <SearchInput
            label="Search people by name or NRC"
            placeholder="Name or NRC / passport…"
            value={searchTerm}
            onChange={setSearchTerm}
          />
          <span className="ml-auto text-[length:var(--text-xs)] text-[var(--text-muted)] tabular-nums">
            {filtered.length} of {people.length}
          </span>
        </Toolbar>
      )}

      <PageBody className="space-y-4">
        {loadError && <Notice tone="danger" title="Could not load the register">{loadError}</Notice>}

        {people.length === 0 ? (
          <EmptyState
            icon={<Contact className="w-4 h-4" />}
            title="The People Register is empty"
            description="Nobody has been added yet."
            steps={[
              {
                title: "Sync from companies",
                body: "Reads the directors and individual shareholders off every company filing and adds them here, deduplicated by NRC / passport. Fastest way to fill the register.",
              },
              {
                title: "Or add the person by hand",
                body: "Eight fields: name, nationality, NRC / passport, gender, date of birth, phone, email and address.",
              },
              {
                title: "Link them to a company",
                body: "Pick a role — Director, Individual Shareholder, or Both. Shares, capital and appointed date belong to the link, not to the person.",
              },
            ]}
            action={
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  onClick={syncFromCompanies}
                  disabled={syncing}
                  icon={<RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />}
                >
                  {syncing ? "Syncing…" : "Sync from companies"}
                </Button>
                <Button variant="secondary" onClick={openCreate} icon={<UserPlus className="w-4 h-4" />}>
                  Add the first person
                </Button>
              </div>
            }
          />
        ) : (
          <>
            <StatRow>
              <StatTile label="On register" value={stats.total} />
              <StatTile label="Linked to a company" value={stats.linked} hint={`${stats.total - stats.linked} unlinked`} />
              <StatTile label="Acting directors" value={stats.directors} />
              <StatTile
                label="Incomplete"
                value={stats.incomplete}
                tone={stats.incomplete > 0 ? "warn" : undefined}
                hint={stats.incomplete > 0 ? "Will fall back to placeholders" : "All records complete"}
              />
            </StatRow>

            <DataTable<Person>
              rows={filtered}
              columns={columns}
              rowKey={(p) => p.id ?? p.full_name}
              onRowClick={openDetail}
              caption="People register"
              rowTone={(p) => (missingFields(p).length > 0 ? "var(--warn)" : null)}
              empty={
                <div className="py-2">
                  <p className="text-[length:var(--text-sm)] text-[var(--text)]">
                    No match for &ldquo;{searchTerm}&rdquo;
                  </p>
                  <p className="mt-0.5 text-[length:var(--text-xs)] text-[var(--text-muted)]">
                    Search matches full name and NRC / passport number.
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

      {personForm}
    </Page>
  )
}
