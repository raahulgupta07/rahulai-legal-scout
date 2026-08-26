"use client"

import { Eye } from "lucide-react"
import { useCanWrite } from "@/app/admin/roleClient"

/**
 * Shown to an account that may view a register but not change it.
 *
 * Without this, a viewer sees a page whose Add / Edit / Delete controls have
 * simply vanished and has no way to tell whether that is policy or a fault.
 * Saying so plainly is the difference between "restricted" and "broken".
 */
export default function ReadOnlyNotice({ what = "these records" }: { what?: string }) {
  const mayWrite = useCanWrite()
  if (mayWrite) return null
  return (
    <div className="mb-3 flex items-start gap-2 rounded-[var(--radius-md,8px)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2">
      <Eye className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      <span className="text-[length:var(--text-xs)] leading-relaxed text-[var(--text-secondary)]">
        You have <b>view-only</b> access to {what}. Ask an administrator to add, change or remove
        anything here.
      </span>
    </div>
  )
}
