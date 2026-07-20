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

    // Role-based access control
    // user: chat only (/ and /?agent=... pages)
    // editor: chat + admin dashboard (but NOT /admin/users)
    // admin: everything

    // Role access:
    // admin: everything
    // editor: everything except /admin/users
    // user: chat + dashboard + documents (NOT templates, companies, knowledge, users)
    const adminOnlyPages = ["/admin/users", "/admin/settings"]
    const editorPages = ["/admin/templates", "/admin/companies", "/admin/knowledge"]

    if (adminOnlyPages.some(p => pathname?.startsWith(p))) {
      if (role !== "admin") {
        setDenied("Only administrators can manage users.")
        setChecking(false)
        return
      }
    } else if (editorPages.some(p => pathname?.startsWith(p))) {
      if (role === "user") {
        setDenied("You need editor or admin access for this page. Contact your admin.")
        setChecking(false)
        return
      }
    }
    // Chat pages (/ and anything not /admin) — all roles allowed

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
      {/* rounded-[999px] rather than rounded-full: globals.css carries a
          `body .rounded-full { border-radius: 0 !important }` sweep, which
          was turning this spinner into a spinning square. */}
      <div className="animate-spin rounded-[999px] h-6 w-6 border-2 border-[var(--border)] border-t-[var(--brand)]" />
    </div>
  )
  if (denied) return <AccessDenied message={denied} />
  if (!isAuth) return null

  return <>{children}</>
}
