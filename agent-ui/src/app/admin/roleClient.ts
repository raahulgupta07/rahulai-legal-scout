"use client"

import { useEffect, useState } from "react"

/** Role precedence, mirroring the sidebar and AuthGuard. */
export const RANK: Record<string, number> = { user: 0, editor: 1, admin: 2, super_admin: 3 }

/** Synchronous read of the stored role. Client-only (touches localStorage). */
export function getRole(): string {
  try {
    const raw = localStorage.getItem("ls_user")
    return raw ? JSON.parse(raw).role || "user" : "user"
  } catch (e) {
    console.error("roleClient: could not read stored user", e)
    return "user"
  }
}

/** Reactive role for rendering — resolves after mount, defaults to "user". */
export function useUserRole(): string {
  const [role, setRole] = useState("user")
  useEffect(() => {
    setRole(getRole())
  }, [])
  return role
}

/**
 * May this account CHANGE shared firm records — the registers, templates,
 * knowledge and people?
 *
 * ★ This is a rendering convenience, NOT the boundary. The server decides:
 * every mutating route now calls `require_write`, and it refuses whatever the
 * browser sends regardless of which buttons were drawn. Hiding a control that
 * the API would still accept is exactly the kind of decorative permission this
 * codebase has produced before — so treat a `false` here as "don't offer it",
 * never as "it is prevented".
 *
 * Kept at admin deliberately, mirroring `ROLE_RANK` and `require_write` in
 * app/main.py. If `editor` ever becomes a real writer, both move together.
 */
export function canWrite(role: string): boolean {
  return (RANK[role] ?? 0) >= RANK.admin
}

/** Reactive form of {@link canWrite}, for components that render by role. */
export function useCanWrite(): boolean {
  return canWrite(useUserRole())
}
