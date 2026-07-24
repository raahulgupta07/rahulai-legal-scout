"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Pencil, Plus, Shield, Trash2 } from "lucide-react"
import { authFetch } from "@/lib/api-client"
import { toast } from "sonner"
import {
  Badge,
  Button,
  Card,
  type Column,
  ConfirmButton,
  DataTable,
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
  type Tone,
  Toolbar,
  assertSuccess,
  dateSort,
  ensureOk,
  errorMessage,
  formatDate,
  formatDateTime,
} from "@/components/ui/kit"

interface User {
  id: number
  email: string
  name: string
  role: string
  status: string
  created_at: string
}

interface ActivityLog {
  id: number
  user_email: string
  action: string
  details: string
  timestamp: string
}

const API_BASE = `${process.env.NEXT_PUBLIC_API_URL || ""}/api/admin`

const ROLE_OPTIONS = [
  { value: "user", label: "User — chat only" },
  { value: "editor", label: "Editor — manage registers" },
  { value: "admin", label: "Admin — full access" },
]

const ROLE_TONE: Record<string, Tone> = { admin: "danger", editor: "info", user: "neutral" }

/** What each role can actually reach, mirroring the sidebar's gating. */
const ROLE_SCOPE: Record<string, string> = {
  admin: "Everything, including users and settings",
  editor: "Templates, companies, people and knowledge",
  user: "Chat, documents and emails",
}

export default function UsersView() {
  const [users, setUsers] = useState<User[]>([])
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [loading, setLoading] = useState(true)
  const [logsLoading, setLogsLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [formError, setFormError] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [formData, setFormData] = useState({ email: "", name: "", password: "", role: "user" })

  const fetchUsers = useCallback(async () => {
    try {
      const res = await authFetch(`${API_BASE}/users`)
      await ensureOk(res, "Failed to load users")
      const data = await res.json()
      setUsers(Array.isArray(data) ? data : data.users || [])
      setError("")
    } catch (e: any) {
      console.error("Fetch users error:", e)
      setError(e?.message || "Failed to load users")
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true)
    try {
      const res = await authFetch(`${API_BASE}/activity-logs`)
      await ensureOk(res, "Failed to load activity logs")
      const data = await res.json()
      setLogs(Array.isArray(data) ? data : data.logs || [])
    } catch (e: any) {
      console.error("Fetch logs error:", e)
      toast.error(e?.message || "Failed to load activity logs")
    } finally {
      setLogsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchUsers()
    fetchLogs()
  }, [fetchUsers, fetchLogs])

  const openCreateModal = () => {
    setEditingUser(null)
    setFormData({ email: "", name: "", password: "", role: "user" })
    setFormError("")
    setShowModal(true)
  }

  const openEditModal = (user: User) => {
    setEditingUser(user)
    setFormData({ email: user.email, name: user.name, password: "", role: user.role })
    setFormError("")
    setShowModal(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError("")
    setSaving(true)
    try {
      let res: Response
      if (editingUser) {
        const body: Record<string, string> = { name: formData.name, role: formData.role }
        if (formData.password) body.password = formData.password
        res = await authFetch(`${API_BASE}/users/${editingUser.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      } else {
        res = await authFetch(`${API_BASE}/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        })
      }
      if (!res.ok) throw new Error(await errorMessage(res, editingUser ? "Update failed" : "Create failed"))
      await assertSuccess(res, editingUser ? "Update failed" : "Create failed")
      toast.success(editingUser ? `"${formData.name}" updated` : `"${formData.name}" created`)
      setShowModal(false)
      await fetchUsers()
      await fetchLogs()
    } catch (err: any) {
      console.error("Save user error:", err)
      setFormError(err?.message || "Request failed")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (user: User) => {
    try {
      const res = await authFetch(`${API_BASE}/users/${user.id}`, { method: "DELETE" })
      if (!res.ok) throw new Error(await errorMessage(res, "Failed to delete user"))
      await assertSuccess(res, "Failed to delete user")
      toast.success(`"${user.name}" deleted`)
      await fetchUsers()
      await fetchLogs()
    } catch (e: any) {
      console.error("Delete user error:", e)
      toast.error(e?.message || "Failed to delete user")
    }
  }

  const term = searchTerm.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      term
        ? users.filter(
            (u) => u.email?.toLowerCase().includes(term) || u.name?.toLowerCase().includes(term)
          )
        : users,
    [users, term]
  )

  const stats = useMemo(() => {
    const byRole = (role: string) => users.filter((u) => u.role === role).length
    return {
      total: users.length,
      admins: byRole("admin"),
      editors: byRole("editor"),
      inactive: users.filter((u) => (u.status || "active") !== "active").length,
    }
  }, [users])

  if (loading) return <LoadingScreen label="Loading users" />

  const columns: Column<User>[] = [
    {
      key: "name",
      header: "User",
      sortValue: (u) => u.name || u.email,
      render: (u) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-7 h-7 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] text-[length:var(--text-2xs)] font-semibold text-[var(--text-secondary)] rounded-[var(--radius-sm)]">
            {(u.name || u.email || "?").charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-[var(--text)] truncate">{u.name || "—"}</span>
            <span className="block text-[length:var(--text-2xs)] text-[var(--text-muted)] truncate">{u.email}</span>
          </span>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      sortValue: (u) => u.role,
      render: (u) => (
        <span className="inline-flex flex-col gap-0.5">
          <Badge tone={ROLE_TONE[u.role] || "neutral"} dot>
            {u.role}
          </Badge>
          <span className="text-[length:var(--text-2xs)] text-[var(--text-muted)]">{ROLE_SCOPE[u.role] || ""}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (u) => u.status || "active",
      render: (u) =>
        (u.status || "active") === "active" ? (
          <Badge tone="ok" dot>
            Active
          </Badge>
        ) : (
          <Badge tone="danger" dot>
            {u.status}
          </Badge>
        ),
    },
    {
      key: "created_at",
      header: "Created",
      hideBelow: "md",
      sortValue: (u) => dateSort(u.created_at),
      render: (u) => <span className="tabular-nums whitespace-nowrap">{formatDate(u.created_at)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "1%",
      stopClickPropagation: true,
      render: (u) => (
        <div className="flex items-center justify-end gap-0.5">
          <IconButton
            aria-label={`Edit ${u.name || u.email}`}
            title="Edit"
            onClick={() => openEditModal(u)}
            icon={<Pencil className="w-3.5 h-3.5" />}
          />
          <ConfirmButton
            compact
            label={`Delete ${u.name || u.email}`}
            icon={<Trash2 className="w-3.5 h-3.5" />}
            onConfirm={() => handleDelete(u)}
          />
        </div>
      ),
    },
  ]

  return (
    <Page>
      <PageHeader
        title="Users"
        meta={<Badge tone="neutral">{users.length}</Badge>}
        description="Accounts and what each one may reach. Role changes take effect on the user's next sign-in."
        actions={
          <Button variant="primary" onClick={openCreateModal} icon={<Plus className="w-4 h-4" />}>
            Create user
          </Button>
        }
      />

      {users.length > 0 && (
        <Toolbar>
          <SearchInput
            label="Search users by name or email"
            placeholder="Name or email…"
            value={searchTerm}
            onChange={setSearchTerm}
          />
          <span className="ml-auto text-[length:var(--text-xs)] text-[var(--text-muted)] tabular-nums">
            {filtered.length} of {users.length}
          </span>
        </Toolbar>
      )}

      <PageBody className="space-y-4">
        {error && <Notice tone="danger" title="Could not load users">{error}</Notice>}

        {users.length === 0 ? (
          <EmptyState
            icon={<Shield className="w-4 h-4" />}
            title="No users yet"
            description="Create an account for each person who needs access."
            action={
              <Button variant="primary" onClick={openCreateModal} icon={<Plus className="w-4 h-4" />}>
                Create the first user
              </Button>
            }
          />
        ) : (
          <>
            <StatRow>
              <StatTile label="Accounts" value={stats.total} />
              <StatTile label="Admins" value={stats.admins} hint="Full access, including settings" />
              <StatTile label="Editors" value={stats.editors} hint="Can manage the registers" />
              <StatTile
                label="Inactive"
                value={stats.inactive}
                tone={stats.inactive > 0 ? "warn" : undefined}
              />
            </StatRow>

            <DataTable
              rows={filtered}
              columns={columns}
              rowKey={(u) => u.id}
              caption="User accounts"
              rowTone={(u) => ((u.status || "active") === "active" ? null : "var(--danger-strong)")}
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

        <Card
          title="Activity log"
          meta={<Badge tone="neutral">{logs.length}</Badge>}
          actions={
            <Button size="sm" variant="ghost" onClick={fetchLogs} loading={logsLoading}>
              Refresh
            </Button>
          }
          padded={false}
        >
          <DataTable
            className="border-0 rounded-none"
            maxHeight="24rem"
            loading={logsLoading}
            rows={logs}
            rowKey={(l) => l.id}
            empty={<span className="text-[var(--text-muted)]">No activity recorded yet.</span>}
            columns={[
              {
                key: "timestamp",
                header: "Time",
                sortValue: (l) => dateSort(l.timestamp),
                render: (l) => (
                  <span className="tabular-nums whitespace-nowrap text-[var(--text-muted)]">
                    {formatDateTime(l.timestamp)}
                  </span>
                ),
              },
              { key: "user_email", header: "User", sortValue: (l) => l.user_email, render: (l) => l.user_email || "—" },
              {
                key: "action",
                header: "Action",
                sortValue: (l) => l.action,
                render: (l) => <span className="font-medium text-[var(--text)]">{l.action}</span>,
              },
              { key: "details", header: "Details", hideBelow: "md", render: (l) => l.details || "—" },
            ]}
          />
        </Card>
      </PageBody>

      <Modal
        open={showModal}
        onOpenChange={setShowModal}
        size="sm"
        title={editingUser ? "Edit user" : "Create user"}
        description={editingUser ? editingUser.email : "The email address cannot be changed later."}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit} loading={saving}>
              {editingUser ? "Update user" : "Create user"}
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmit}>
          {formError && (
            <div className="mb-3">
              <Notice tone="danger" title="Could not save">
                {formError}
              </Notice>
            </div>
          )}

          <FormGrid>
            <TextField
              label="Email"
              type="email"
              value={formData.email}
              onChange={(v) => setFormData({ ...formData, email: v })}
              required
              wide
              disabled={!!editingUser}
              placeholder="user@example.com"
              hint={editingUser ? "Email is fixed once the account exists" : undefined}
            />
            <TextField
              label="Name"
              value={formData.name}
              onChange={(v) => setFormData({ ...formData, name: v })}
              required
              wide
              placeholder="Full name"
            />
            <TextField
              label="Password"
              type="password"
              value={formData.password}
              onChange={(v) => setFormData({ ...formData, password: v })}
              required={!editingUser}
              wide
              placeholder={editingUser ? "Leave blank to keep the current one" : "At least 10 characters"}
              hint={editingUser ? "Only set this to reset the password" : "Minimum 10 characters"}
            />
            <SelectField
              label="Role"
              value={formData.role}
              onChange={(v) => setFormData({ ...formData, role: v })}
              options={ROLE_OPTIONS}
              wide
              hint={ROLE_SCOPE[formData.role]}
            />
          </FormGrid>

          {/* Lets the browser submit on Enter without showing a second button. */}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </Modal>
    </Page>
  )
}
