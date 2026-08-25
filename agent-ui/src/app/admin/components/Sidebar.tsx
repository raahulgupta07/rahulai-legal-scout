'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect } from 'react'
import {
  LayoutDashboard,
  FileText,
  Users,
  Contact,
  FolderOpen,
  Brain,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Mail,
  Shield,
  LogOut,
  Settings
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { focusRing } from '@/components/ui/kit'

interface NavItem {
  name: string
  href: string
  icon: React.ReactNode
  /** Lowest role allowed to see the item. */
  minRole: 'user' | 'editor' | 'admin'
}

/**
 * Grouped so the rail reads as a workflow rather than a flat pile of links:
 * what you produce, what it is produced from, and who may do it.
 */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Overview',
    items: [
      { name: 'Dashboard', href: '/admin/dashboard', icon: <LayoutDashboard className="w-4 h-4" />, minRole: 'user' },
      { name: 'Documents', href: '/admin/documents', icon: <FileText className="w-4 h-4" />, minRole: 'user' },
      { name: 'Emails', href: '/admin/emails', icon: <Mail className="w-4 h-4" />, minRole: 'user' }
    ]
  },
  {
    label: 'Registers',
    items: [
      { name: 'Templates', href: '/admin/templates', icon: <FolderOpen className="w-4 h-4" />, minRole: 'editor' },
      { name: 'Companies', href: '/admin/companies', icon: <Users className="w-4 h-4" />, minRole: 'editor' },
      { name: 'People', href: '/admin/people', icon: <Contact className="w-4 h-4" />, minRole: 'editor' },
      { name: 'Knowledge', href: '/admin/knowledge', icon: <Brain className="w-4 h-4" />, minRole: 'editor' }
    ]
  },
  {
    label: 'Administration',
    items: [
      { name: 'Users', href: '/admin/users', icon: <Shield className="w-4 h-4" />, minRole: 'admin' },
      { name: 'Settings', href: '/admin/settings', icon: <Settings className="w-4 h-4" />, minRole: 'admin' }
    ]
  }
]

const RANK: Record<string, number> = { user: 0, editor: 1, admin: 2 }

export default function DashboardSidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [userRole, setUserRole] = useState('user')
  const [userName, setUserName] = useState('User')

  useEffect(() => {
    try {
      const raw = localStorage.getItem('ls_user')
      if (raw) {
        const u = JSON.parse(raw)
        setUserRole(u.role || 'user')
        setUserName(u.name || u.email?.split('@')[0] || 'User')
      }
    } catch (e) {
      console.error('Sidebar: could not read stored user', e)
    }
  }, [])

  // `/admin/templates/upload` must keep Templates lit, so match by prefix.
  const isActive = (href: string) => {
    const path = (pathname || '').replace(/\/$/, '')
    return path === href || path.startsWith(`${href}/`)
  }

  const canSee = (item: NavItem) => (RANK[userRole] ?? 0) >= RANK[item.minRole]

  const logout = () => {
    localStorage.removeItem('ls_token')
    localStorage.removeItem('ls_user')
    window.location.href = '/login'
  }

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-[var(--surface)] border-r border-[var(--border)] transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-60'
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 h-12 border-b border-[var(--border)]">
        {!collapsed && (
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-6 h-6 shrink-0 grid place-items-center overflow-hidden bg-[var(--ink)] rounded-[var(--radius-sm)]">
              <img src="/logo.png" alt="" className="h-[18px] w-[18px] object-contain" />
            </span>
            <span className="font-[family-name:var(--font-display)] text-[length:var(--text-sm)] font-semibold text-[var(--text)] truncate">
              Legal Scout
            </span>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'p-1.5 text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-secondary)] transition-colors rounded-[var(--radius-sm)]',
            collapsed && 'mx-auto',
            focusRing
          )}
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter(canSee)
          if (items.length === 0) return null
          return (
            <div key={group.label} className="mb-1">
              {!collapsed && (
                <p className="px-3 pt-2.5 pb-1 text-[length:var(--text-2xs)] font-semibold uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                  {group.label}
                </p>
              )}
              {items.map((item) => {
                const active = isActive(item.href)
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    title={collapsed ? item.name : undefined}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'relative flex items-center gap-2.5 mx-1.5 px-2.5 py-1.5 text-[length:var(--text-sm)] transition-colors rounded-[var(--radius-sm)]',
                      collapsed && 'justify-center',
                      active
                        ? 'bg-[var(--bg-secondary)] text-[var(--text)] font-medium'
                        : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-secondary)]',
                      focusRing
                    )}
                  >
                    {/* One accent mark for the current page — not on every item. */}
                    {active && (
                      <span
                        aria-hidden
                        className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-[var(--brand)]"
                      />
                    )}
                    {item.icon}
                    {!collapsed && <span className="truncate">{item.name}</span>}
                  </Link>
                )
              })}
            </div>
          )
        })}
      </nav>

      <div className="border-t border-[var(--border)] p-1.5">
        <Link
          href="/"
          title={collapsed ? 'Open Legal Scout chat' : undefined}
          className={cn(
            'flex items-center gap-2.5 px-2.5 py-1.5 mb-1 text-[length:var(--text-sm)] rounded-[var(--radius-sm)]',
            'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-secondary)] transition-colors',
            collapsed && 'justify-center',
            focusRing
          )}
        >
          <MessageCircle className="w-4 h-4" />
          {!collapsed && <span>Open chat</span>}
        </Link>

        {!collapsed && (
          <div className="flex items-center gap-2.5 px-2.5 py-2 min-w-0">
            <span className="w-6 h-6 shrink-0 grid place-items-center bg-[var(--bg-secondary)] border border-[var(--border)] text-[length:var(--text-2xs)] font-semibold text-[var(--text-secondary)] rounded-[var(--radius-sm)]">
              {userName[0]?.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[length:var(--text-xs)] font-medium text-[var(--text)] truncate">{userName}</p>
              <p className="text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]">
                {userRole}
              </p>
            </div>
          </div>
        )}

        <button
          onClick={logout}
          title={collapsed ? 'Sign out' : undefined}
          className={cn(
            'flex items-center gap-2.5 w-full px-2.5 py-1.5 text-[length:var(--text-sm)] rounded-[var(--radius-sm)]',
            'text-[var(--text-muted)] hover:text-[var(--danger-strong)] hover:bg-[color-mix(in_srgb,var(--danger-strong)_10%,transparent)] transition-colors',
            collapsed && 'justify-center',
            focusRing
          )}
        >
          <LogOut className="w-4 h-4" />
          {!collapsed && <span>Sign out</span>}
        </button>
      </div>
    </div>
  )
}
