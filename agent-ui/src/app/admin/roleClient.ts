"use client"

import { useEffect, useState } from "react"

/** Role precedence, mirroring the sidebar and AuthGuard. */
export const RANK: Record<string, number> = { user: 0, editor: 1, admin: 2 }

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
