"use client"

import { Suspense } from "react"

/**
 * The rail and the mobile chrome now live in the root AppShell, mounted once so
 * they persist across chat↔admin. This layout is just a scroll container for
 * the admin pages.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-secondary)] font-[family-name:var(--font-body)]">
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  )
}
