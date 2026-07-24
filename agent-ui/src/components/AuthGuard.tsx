"use client"

import { useEffect, useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import { ShieldAlert } from "lucide-react"

interface UserInfo {
  id: number
  email: string
  name: string
  role: string  // "admin" | "editor" | "user"
}

function getUser(): UserInfo | null {
  try {
    const raw = localStorage.getItem("ls_user")
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

const RANK: Record<string, number> = { user: 0, editor: 1, admin: 2 }

/**
 * Minimum role required to LOAD each admin path. Longest-prefix match wins, so
 * `/admin/templates/upload` inherits `/admin/templates`. These mirror the
 * sidebar's per-item minRole. Query params (e.g. ?tab=people) cannot be
 * path-guarded, so the tabbed pages additionally gate each tab's render by role.
 *
 * New consolidated routes carry the LOWEST minRole among their tabs; the pages
 * hide the higher-role tabs from lower roles:
 *   - /admin/overview  → all tabs are "user"
 *   - /admin/registers → all tabs are "editor"
 *   - /admin/settings  → Knowledge is editor-visible; AI models / Email / System
 *     / Activity / Users are admin-only and never render for a non-admin.
 */
const ROUTE_MIN_ROLE: [string, keyof typeof RANK][] = [
  ["/admin/overview", "user"],
  ["/admin/registers", "editor"],
  ["/admin/settings", "editor"],
  // Legacy routes still redirect through the guard — keep them gated.
  ["/admin/dashboard", "user"],
  ["/admin/documents", "user"],
  ["/admin/emails", "user"],
  ["/admin/templates", "editor"],
  ["/admin/companies", "editor"],
  ["/admin/people", "editor"], // previously UNGUARDED — a "user" could reach it by URL; now closed
  ["/admin/knowledge", "editor"],
  ["/admin/users", "admin"],
]

/** The most specific matching rule, or null when the path is unrestricted. */
function requiredRole(pathname: string): keyof typeof RANK | null {
  const path = pathname.replace(/\/$/, "")
  let best: { key: string; role: keyof typeof RANK } | null = null
  for (const [key, role] of ROUTE_MIN_ROLE) {
    if ((path === key || path.startsWith(`${key}/`)) && (!best || key.length > best.key.length)) {
      best = { key, role }
    }
  }
  return best?.role ?? null
}

function AccessDenied({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-screen gap-3 bg-[var(--bg-secondary)] px-6">
      <ShieldAlert className="w-8 h-8 text-[var(--danger-strong)]" />
      <h2 className="font-[family-name:var(--font-display)] text-[length:var(--text-lg)] font-semibold text-[var(--text)]">
        Access denied
      </h2>
      <p className="text-[length:var(--text-sm)] text-[var(--text-muted)] max-w-sm text-center">{message}</p>
      <a
        href="/"
        className="text-[length:var(--text-sm)] text-[var(--brand)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]"
      >
        Go to chat
      </a>
    </div>
  )
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const [isAuth, setIsAuth] = useState(false)
  const [checking, setChecking] = useState(true)
  const [denied, setDenied] = useState("")
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    const token = localStorage.getItem("ls_token")
    if (!token && pathname !== "/login" && pathname !== "/login/") {
      router.push("/login/")
      setChecking(false)
      return
    }
    if (!token) { setChecking(false); return }

    const user = getUser()
    const role = user?.role || "user"

    // Role-based access control. The minimum role per admin path lives in
    // ROUTE_MIN_ROLE; chat pages (/ and anything not under /admin) are open to
    // all authenticated roles. Tab-level gating inside the consolidated pages
    // covers the query-param cases a path guard cannot reach.
    const needed = requiredRole(pathname || "")
    if (needed && (RANK[role] ?? 0) < RANK[needed]) {
      setDenied(
        needed === "admin"
          ? "Only administrators can access this area."
          : "You need editor or admin access for this page. Contact your admin."
      )
      setChecking(false)
      return
    }

    setIsAuth(true)
    setDenied("")
    setChecking(false)
  }, [pathname, router])

  if (pathname === "/login" || pathname === "/login/") return <>{children}</>
  if (checking) return (
    <div
      role="status"
      aria-label="Checking your session"
      className="flex items-center justify-center h-screen bg-[var(--bg-secondary)]"
    >
      {/* rounded-[999px] rather than rounded-full: a pill radius that keeps
          this spinner circular regardless of the Tailwind rounding scale. */}
      <div className="animate-spin rounded-[999px] h-6 w-6 border-2 border-[var(--border)] border-t-[var(--brand)]" />
    </div>
  )
  if (denied) return <AccessDenied message={denied} />
  if (!isAuth) return null

  return <>{children}</>
}
