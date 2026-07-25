"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { BookMarked, Plus } from "lucide-react"
import { apiClient, authFetch } from "@/lib/api-client"
import { useUserRole } from "../roleClient"
import { toast } from "sonner"
import {
  Badge,
  Button,
  type Column,
  ConfirmButton,
  DataTable,
  EmptyState,
  Field,
  FormGrid,
  LoadingScreen,
  Modal,
  Notice,
  Page,
  PageBody,
  PageHeader,
  SearchInput,
  Segmented,
  StatRow,
  StatTile,
  Textarea,
  TextField,
  TextareaField,
  type Tone,
  Toolbar,
  assertSuccess,
  dateSort,
  ensureOk,
  errorMessage,
  formatDateTime,
  formatNumber,
} from "@/components/ui/kit"

/** A legal playbook the agent can load on demand. `body` is only present once
 *  a single skill has been fetched for editing — the list omits it (body_chars). */
interface Skill {
  id: number
  name: string
  description: string
  version: string
  enabled: boolean
  source: string // "adapted" | "native" | "manual"
  updated_at: string | null
  body_chars: number
  body?: string
}

type SourceFilter = "all" | "adapted" | "native" | "manual"

/** adapted = blue, native = green, manual = grey. */
const SOURCE_TONE: Record<string, Tone> = { adapted: "accent", native: "ok", manual: "neutral" }

const SOURCE_LABEL: Record<string, string> = {
  adapted: "Adapted",
  native: "Native",
  manual: "Manual",
}

const emptyForm = { name: "", description: "", version: "1.0", body: "" }

export default function SkillsView() {
  const role = useUserRole()
  const isAdmin = role === "admin"

  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [filter, setFilter] = useState<SourceFilter>("all")

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Skill | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState("")
  const [form, setForm] = useState(emptyForm)

  const fetchSkills = useCallback(async () => {
    setLoadError("")
    try {
      const res = await authFetch(apiClient.getSkills())
      await ensureOk(res, "Failed to load skills")
      const data = await res.json()
      setSkills(Array.isArray(data) ? data : data.skills || [])
    } catch (e: any) {
      console.error("Fetch skills error:", e)
      setLoadError(e?.message || "Failed to load skills")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSkills()
  }, [fetchSkills])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setFormError("")
    setBodyLoading(false)
    setShowModal(true)
  }

  const openEdit = async (skill: Skill) => {
    setEditing(skill)
    setForm({
      name: skill.name,
      description: skill.description || "",
      version: skill.version || "",
      body: skill.body || "",
    })
    setFormError("")
    setShowModal(true)
    // The list omits the body; pull the full record so it can be viewed/edited.
    setBodyLoading(true)
    try {
      const res = await authFetch(apiClient.getSkill(skill.name))
      await ensureOk(res, "Failed to load skill body")
      const data = await res.json()
      const full = data.skill || data
      setForm((f) => ({
        ...f,
        description: full.description ?? f.description,
        version: full.version ?? f.version,
        body: full.body ?? "",
      }))
    } catch (e: any) {
      console.error("Fetch skill body error:", e)
      setFormError(e?.message || "Could not load the skill body")
    } finally {
      setBodyLoading(false)
    }
  }

  const toggleSkill = async (skill: Skill) => {
    const next = !skill.enabled
    // Optimistic — flip locally, revert if the server disagrees.
    setSkills((rows) => rows.map((s) => (s.id === skill.id ? { ...s, enabled: next } : s)))
    try {
      const res = await authFetch(apiClient.toggleSkill(skill.name), { method: "POST" })
      if (!res.ok) throw new Error(await errorMessage(res, "Toggle failed"))
      await assertSuccess(res, "Toggle failed")
      toast.success(`"${skill.name}" ${next ? "enabled" : "disabled"}`)
    } catch (e: any) {
      console.error("Toggle skill error:", e)
      setSkills((rows) => rows.map((s) => (s.id === skill.id ? { ...s, enabled: skill.enabled } : s)))
      toast.error(e?.message || "Could not change the skill")
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError("")
    setSaving(true)
    try {
      let res: Response
      if (editing) {
        res = await authFetch(apiClient.updateSkill(editing.name), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: form.description,
            version: form.version,
            body: form.body,
          }),
        })
      } else {
        res = await authFetch(apiClient.createSkill(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            description: form.description,
            version: form.version,
            body: form.body,
          }),
        })
      }
      if (!res.ok) throw new Error(await errorMessage(res, editing ? "Update failed" : "Create failed"))
      await assertSuccess(res, editing ? "Update failed" : "Create failed")
      toast.success(editing ? `"${form.name}" saved` : `"${form.name}" created`)
      setShowModal(false)
      await fetchSkills()
    } catch (err: any) {
      console.error("Save skill error:", err)
      setFormError(err?.message || "Request failed")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    try {
      const res = await authFetch(apiClient.deleteSkill(editing.name), { method: "DELETE" })
      if (!res.ok) throw new Error(await errorMessage(res, "Delete failed"))
      await assertSuccess(res, "Delete failed")
      toast.success(`"${editing.name}" deleted`)
      setShowModal(false)
      await fetchSkills()
    } catch (e: any) {
      console.error("Delete skill error:", e)
      setFormError(e?.message || "Could not delete the skill")
    }
  }

  const stats = useMemo(() => {
    const bySource = (s: string) => skills.filter((k) => k.source === s).length
    return {
      total: skills.length,
      enabled: skills.filter((k) => k.enabled).length,
      adapted: bySource("adapted"),
      native: bySource("native"),
      manual: bySource("manual"),
    }
  }, [skills])

  const term = searchTerm.trim().toLowerCase()
  const filtered = useMemo(() => {
    let rows = skills
    if (filter !== "all") rows = rows.filter((s) => s.source === filter)
    if (term) {
      rows = rows.filter(
        (s) =>
          s.name?.toLowerCase().includes(term) || s.description?.toLowerCase().includes(term)
      )
    }
    return rows
  }, [skills, filter, term])

  if (loading) return <LoadingScreen label="Loading skills" />

  const columns: Column<Skill>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (s) => s.name,
      render: (s) => (
        <span className="font-mono text-[length:var(--text-sm)] font-medium text-[var(--text)]">
          {s.name}
        </span>
      ),
    },
    {
      key: "description",
      header: "Trigger",
      sortValue: (s) => s.description,
      render: (s) => (
        <span
          className="block max-w-[46ch] truncate text-[var(--text-secondary)]"
          title={s.description || undefined}
        >
          {s.description || "—"}
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      sortValue: (s) => s.source,
      render: (s) => (
        <Badge tone={SOURCE_TONE[s.source] || "neutral"} dot>
          {SOURCE_LABEL[s.source] || s.source}
        </Badge>
      ),
    },
    {
      key: "version",
      header: "Version",
      hideBelow: "md",
      sortValue: (s) => s.version,
      render: (s) => <span className="tabular-nums text-[var(--text-muted)]">{s.version || "—"}</span>,
    },
    {
      key: "updated_at",
      header: "Updated",
      hideBelow: "lg",
      sortValue: (s) => dateSort(s.updated_at),
      render: (s) => <span className="tabular-nums whitespace-nowrap">{formatDateTime(s.updated_at)}</span>,
    },
    {
      key: "enabled",
      header: "Enabled",
      align: "right",
      width: "1%",
      stopClickPropagation: true,
      sortValue: (s) => (s.enabled ? 1 : 0),
      render: (s) =>
        isAdmin ? (
          <button
            type="button"
            role="switch"
            aria-checked={s.enabled}
            aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
            onClick={() => toggleSkill(s)}
            className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-[var(--radius-full)] border border-[var(--border)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
            style={{
              background: s.enabled
                ? "var(--brand)"
                : "color-mix(in srgb, var(--border) 60%, transparent)",
            }}
          >
            <span
              aria-hidden
              className="inline-block h-3.5 w-3.5 rounded-[var(--radius-full)] bg-[var(--surface)] shadow transition-transform"
              style={{ transform: s.enabled ? "translateX(18px)" : "translateX(3px)" }}
            />
          </button>
        ) : (
          <Badge tone={s.enabled ? "ok" : "neutral"} dot>
            {s.enabled ? "On" : "Off"}
          </Badge>
        ),
    },
  ]

  const canDelete = isAdmin && editing?.source === "manual"

  return (
    <Page>
      <PageHeader
        title="Skills"
        meta={<Badge tone="neutral">{skills.length}</Badge>}
        description="Legal playbooks the agent loads on demand."
        actions={
          isAdmin ? (
            <Button variant="primary" onClick={openCreate} icon={<Plus className="w-4 h-4" />}>
              Add skill
            </Button>
          ) : undefined
        }
      />

      {skills.length > 0 && (
        <Toolbar>
          <SearchInput
            label="Search skills by name or trigger"
            placeholder="Name or trigger…"
            value={searchTerm}
            onChange={setSearchTerm}
          />
          <Segmented<SourceFilter>
            label="Filter by source"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: stats.total },
              { value: "adapted", label: "Adapted", count: stats.adapted, tone: "accent" },
              { value: "native", label: "Native", count: stats.native, tone: "ok" },
              { value: "manual", label: "Manual", count: stats.manual },
            ]}
          />
          <span className="ml-auto text-[length:var(--text-xs)] text-[var(--text-muted)] tabular-nums">
            {filtered.length} of {skills.length}
          </span>
        </Toolbar>
      )}

      <PageBody className="space-y-4">
        {loadError && (
          <Notice tone="danger" title="Could not load skills">
            {loadError}
          </Notice>
        )}

        {skills.length === 0 ? (
          <EmptyState
            icon={<BookMarked className="w-4 h-4" />}
            title="No skills yet"
            description="No skills yet — run migrations or add one."
            action={
              isAdmin ? (
                <Button variant="primary" onClick={openCreate} icon={<Plus className="w-4 h-4" />}>
                  Add the first skill
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <StatRow>
              <StatTile
                label="Skills"
                value={stats.total}
                hint={stats.manual > 0 ? `${stats.manual} manual` : undefined}
              />
              <StatTile
                label="Enabled"
                value={stats.enabled}
                tone={stats.enabled > 0 ? "ok" : undefined}
                hint={`${stats.total - stats.enabled} off`}
              />
              <StatTile label="Adapted" value={stats.adapted} hint="From templates" />
              <StatTile label="Native" value={stats.native} hint="Built-in playbooks" />
            </StatRow>

            <DataTable
              rows={filtered}
              columns={columns}
              rowKey={(s) => s.id}
              onRowClick={openEdit}
              caption="Legal skills"
              rowTone={(s) => (s.enabled ? null : "var(--text-muted)")}
              empty={
                <div className="py-2">
                  <p className="text-[length:var(--text-sm)] text-[var(--text)]">No skills match the filters.</p>
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      setSearchTerm("")
                      setFilter("all")
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              }
            />
          </>
        )}
      </PageBody>

      <Modal
        open={showModal}
        onOpenChange={setShowModal}
        title={editing ? (isAdmin ? "Edit skill" : "Skill") : "Add skill"}
        description={
          editing
            ? `${SOURCE_LABEL[editing.source] || editing.source} · ${formatNumber(editing.body_chars)} chars`
            : "A legal playbook the agent can load on demand."
        }
        footer={
          <>
            {canDelete && (
              <span className="mr-auto">
                <ConfirmButton label={`Delete ${editing?.name}`} onConfirm={handleDelete} confirmLabel="Delete skill">
                  Delete
                </ConfirmButton>
              </span>
            )}
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              {isAdmin ? "Cancel" : "Close"}
            </Button>
            {isAdmin && (
              <Button variant="primary" onClick={handleSave} loading={saving}>
                {editing ? "Save skill" : "Create skill"}
              </Button>
            )}
          </>
        }
      >
        <form onSubmit={handleSave}>
          {formError && (
            <div className="mb-3">
              <Notice tone="danger" title="Could not save">
                {formError}
              </Notice>
            </div>
          )}

          <FormGrid>
            <TextField
              label="Name"
              value={form.name}
              onChange={(v) => setForm({ ...form, name: v })}
              required
              mono
              disabled={!!editing || !isAdmin}
              placeholder="agm_minutes_playbook"
              hint={editing ? "The name is fixed once the skill exists" : "A short identifier — lowercase, no spaces"}
            />
            <TextField
              label="Version"
              value={form.version}
              onChange={(v) => setForm({ ...form, version: v })}
              disabled={!isAdmin}
              placeholder="1.0"
            />
            <TextareaField
              label="Trigger"
              value={form.description}
              onChange={(v) => setForm({ ...form, description: v })}
              wide
              rows={2}
              placeholder="When the agent should reach for this skill…"
            />
            <Field label="Body" wide hint={bodyLoading ? "Loading the full body…" : "Markdown the agent reads when the skill loads"}>
              <Textarea
                rows={18}
                value={form.body}
                disabled={!isAdmin || bodyLoading}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder={bodyLoading ? "Loading…" : "## Skill\n\nStep-by-step legal playbook…"}
                className="font-mono text-[length:var(--text-sm)] leading-relaxed"
              />
            </Field>
          </FormGrid>

          {/* Lets the browser submit on Enter without showing a second button. */}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </Modal>
    </Page>
  )
}
