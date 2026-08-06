'use client'

/**
 * App frame: the unified rail on the left, the routed page on the right. It is
 * rendered once, from the root layout, so the rail survives every chat↔admin
 * transition without a remount.
 *
 * The login route is chromeless — there is no signed-in user to hang a rail
 * off — so the shell steps aside and renders the page bare.
 *
 * On mobile the rail is a drawer: a top bar carries the hamburger, and the rail
 * slides over the page. This replaces the per-shell mobile headers the old chat
 * page and admin layout each carried.
 */

import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { IconButton } from '@/components/ui/kit'
import AppRail from './AppRail'
import ImportTray from './ImportTray'

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  if (pathname?.startsWith('/login')) return <>{children}</>

  return (
    <div className="flex h-screen bg-[var(--bg-secondary)] font-[family-name:var(--font-body)]">
      {/* Desktop rail — always present */}
      <div className="hidden shrink-0 md:block">
        <AppRail />
      </div>

      {/* Mobile rail — drawer overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-[color-mix(in_srgb,var(--surface-inverse)_45%,transparent)]"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative h-full">
            <AppRail forceExpanded onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex items-center gap-2.5 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 md:hidden">
          <IconButton
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileOpen(!mobileOpen)}
            icon={mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          />
          <div className="flex items-center gap-2">
            <span className="grid h-5 w-5 place-items-center rounded-[var(--radius-md)] bg-[var(--ink)] text-[10px] font-semibold text-[var(--text-inverse)]">
              LS
            </span>
            <span className="text-[13px] font-semibold text-[var(--text)]">
              Legal Scout
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>

      {/* Docked here, not on a page: a bulk import keeps running while the
          operator moves between Templates, Companies and People. */}
      <ImportTray />
    </div>
  )
}
