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
  Trash2,
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

          <Card title="Person record" meta={<Badge tone="neutral">8 fields</Badge>}>
            <DetailList
              items={[
                ["Full name", p.full_name],
                ["NRC / passport", <span key="nrc" className="font-mono tabular-nums">{p.nrc_passport_no || "—"}</span>],
                ["Nationality", p.nationality],
                ["Gender", p.gender],
                ["Date of birth", p.date_of_birth ? formatDate(p.date_of_birth) : ""],
                ["Phone", p.phone],
                ["Email", p.email],
                ["Residential address", p.residential_address],
              ]}
            />
          </Card>

          <Card
            title="Company links"
            meta={<Badge tone="neutral">{links.length}</Badge>}
            actions={
              <Button variant="primary" size="sm" onClick={() => setLinkOpen(true)} icon={<Plus className="w-3.5 h-3.5" />}>
                Link company
              </Button>
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
          <Button variant="primary" onClick={openCreate} icon={<Plus className="w-4 h-4" />}>
            Add person
          </Button>
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
                title: "Add the person",
                body: "Eight fields: name, nationality, NRC / passport, gender, date of birth, phone, email and address.",
              },
              {
                title: "Link them to a company",
                body: "Pick a role — Director, Individual Shareholder, or Both.",
              },
              {
                title: "Record shares on the link",
                body: "Shares, capital and appointed date belong to the company link, not to the person.",
              },
            ]}
            action={
              <Button variant="primary" onClick={openCreate} icon={<UserPlus className="w-4 h-4" />}>
                Add the first person
              </Button>
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
