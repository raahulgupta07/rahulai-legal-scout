"use client"

import { Suspense, useState } from "react"
import DashboardSidebar from "./components/Sidebar"
import { Menu, X } from "lucide-react"
import { IconButton } from "@/components/ui/kit"

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  return (
    <div className="flex h-screen bg-[var(--bg-secondary)] font-[family-name:var(--font-body)]">
      {/* Desktop rail */}
      <div className="hidden md:block shrink-0">
        <Suspense fallback={<div className="w-60 h-full bg-[var(--surface)] border-r border-[var(--border)]" />}>
          <DashboardSidebar />
        </Suspense>
      </div>

      {/* Mobile rail, as an overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-[color-mix(in_srgb,var(--surface-inverse)_45%,transparent)]"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-60 h-full" onClick={() => setMobileMenuOpen(false)}>
            <Suspense fallback={<div className="w-60 h-full bg-[var(--surface)]" />}>
              <DashboardSidebar />
            </Suspense>
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <div className="md:hidden flex items-center gap-2.5 px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
          <IconButton
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            icon={mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          />
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 grid place-items-center bg-[var(--ink)] text-[var(--text-inverse)] text-[length:var(--text-2xs)] font-semibold rounded-[var(--radius-sm)]">
              LS
            </span>
            <span className="font-[family-name:var(--font-display)] text-[length:var(--text-sm)] font-semibold text-[var(--text)]">
              Legal Scout
            </span>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  )
}
