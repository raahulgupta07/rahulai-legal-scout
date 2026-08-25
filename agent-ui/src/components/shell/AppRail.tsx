'use client'

/**
 * The one left rail for the whole app — chat and admin share it, and because it
 * is mounted from the root layout it never unmounts as you cross between the
 * two. Density and colour follow the Insights house style: a gray-50 ground,
 * 13px rows, rounded rows, and a single blue accent (--brand) doing all the
 * pointing.
 *
 * Sessions are the existing chat components, untouched in behaviour — this file
 * only re-homes them. The endpoint bootstrap (initialize()) lives here too so
 * that history loads regardless of which route you happen to be on.
 */

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  LayoutGrid,
  Files,
  Settings,
  PlusCircle,
  Search,
  PanelLeft,
  PanelLeftOpen,
  LogOut
} from 'lucide-react'

import Sessions from '@/components/chat/Sidebar/Sessions'
import useChatActions from '@/hooks/useChatActions'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { focusRing } from '@/components/ui/kit'
import ChangelogPanel from '@/components/shell/ChangelogPanel'

const COLLAPSE_KEY = 'ls_rail_collapsed'
// ★ Was a hardcoded 'v2', which never moved through five releases and told
// nobody which build they were looking at. The real number lives in /VERSION
// and is served by GET /api/version; anything else is a second source of
// truth that silently goes stale.
const APP_VERSION_FALLBACK = ''

interface NavItem {
  name: string
  href: string
  Icon: typeof LayoutGrid
  /** Lowest role allowed to see the item — preserved from the old admin rail. */
  minRole: 'user' | 'editor' | 'admin'
}

/**
 * The admin routes, flat (no section captions). The old rail's per-item roles
 * collapse cleanly onto the three consolidated pages: Overview inherits the
 * user-visible Dashboard, Registers the editor-only data pages, Settings the
 * admin-only pages.
 */
const NAV: NavItem[] = [
  { name: 'Overview', href: '/admin/overview', Icon: LayoutGrid, minRole: 'user' },
  { name: 'Registers', href: '/admin/registers', Icon: Files, minRole: 'editor' },
  { name: 'Settings', href: '/admin/settings', Icon: Settings, minRole: 'admin' }
]

const RANK: Record<string, number> = { user: 0, editor: 1, admin: 2 }

interface AppRailProps {
  /** Called after any navigation — used to close the mobile drawer. */
  onNavigate?: () => void
  /** Force the expanded layout (the mobile drawer is never icon-only). */
  forceExpanded?: boolean
}

export default function AppRail({ onNavigate, forceExpanded }: AppRailProps) {
  const pathname = usePathname()
  const router = useRouter()

  const [mounted, setMounted] = useState(false)
  const [storedCollapsed, setStoredCollapsed] = useState(false)
  const [userRole, setUserRole] = useState('user')
  const [user, setUser] = useState({ name: 'User', email: '' })
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK)
  const [showChangelog, setShowChangelog] = useState(false)

  // The version the SERVER is running, not one baked into this bundle — a
  // constant compiled in here would report the frontend's build while the
  // API could be on a different image entirely. Fails quiet: on error the
  // label just reads "Legal Scout" rather than showing a wrong number.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const tok =
          typeof window !== 'undefined' ? localStorage.getItem('ls_token') || '' : ''
        const res = await fetch(
          '/api/version',
          tok ? { headers: { Authorization: `Bearer ${tok}` } } : {}
        )
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && typeof data?.version === 'string' && data.version !== 'unknown') {
          setAppVersion(data.version)
        }
      } catch {
        /* leave the label bare */
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const { clearChat, focusChatInput, initialize } = useChatActions()
  const { selectedEndpoint, hydrated, mode, setMessages } =
    useStore()

  const collapsed = forceExpanded ? false : storedCollapsed

  // Read persisted collapse + identity once mounted (localStorage is client-only).
  useEffect(() => {
    setMounted(true)
    try {
      setStoredCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch {}
    try {
      const raw = localStorage.getItem('ls_user')
      if (raw) {
        const parsed = JSON.parse(raw)
        setUserRole(parsed.role || 'user')
        setUser({
          name: parsed.name || parsed.email?.split('@')[0] || 'User',
          email: parsed.email || ''
        })
      }
    } catch {}
  }, [])

  // Bootstrap agents/teams so the session list has something to load. Mirrors
  // the effect the old chat sidebar owned; kept here now that it is gone.
  useEffect(() => {
    if (hydrated) initialize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEndpoint, hydrated, mode])

  const toggleCollapsed = () => {
    const next = !storedCollapsed
    setStoredCollapsed(next)
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
    } catch {}
  }

  const handleNewChat = () => {
    if (pathname !== '/') {
      // Off the chat page clearChat()'s setSessionId(null) is a nuqs URL
      // write on the CURRENT route, which races with (and cancels) the
      // navigation. Clear the store directly and push a bare "/" — no
      // params means no session, i.e. a fresh chat.
      setMessages([])
      router.push('/')
    } else {
      clearChat()
      focusChatInput()
    }
    onNavigate?.()
  }

  const handleLogout = () => {
    localStorage.removeItem('ls_token')
    localStorage.removeItem('ls_user')
    window.location.href = '/login'
  }

  const canSee = (item: NavItem) => (RANK[userRole] ?? 0) >= RANK[item.minRole]
  const isNavActive = (href: string) => {
    const path = (pathname || '').replace(/\/$/, '')
    return path === href || path.startsWith(`${href}/`)
  }

  const rowBase =
    'flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius-md)] text-[13px] transition-colors'

  return (
    <aside
      className={cn(
        'flex h-screen shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-secondary)] py-2.5',
        'font-[family-name:var(--font-body)] transition-[width] duration-200',
        collapsed ? 'w-14 px-1.5' : 'w-60 px-2.5'
      )}
    >
      {/* 1 — Identity + rail controls */}
      <div
        className={cn(
          'flex shrink-0',
          collapsed
            ? 'flex-col items-center gap-1.5'
            : 'items-center justify-between gap-2 px-0.5'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* The mark is white artwork on transparency, so it keeps the ink
              square it has always sat on — that square is what makes it read
              in both themes. */}
          <span
            aria-hidden
            className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-md)] bg-[var(--ink)]"
          >
            <img src="/logo.png" alt="" className="h-[18px] w-[18px] object-contain" />
          </span>
          {!collapsed && (
            <span className="truncate text-[13px] font-semibold text-[var(--text)]">
              Legal Scout
            </span>
          )}
        </div>

        <div className={cn('flex items-center', collapsed ? '' : 'gap-0.5')}>
          {!collapsed && (
            <button
              type="button"
              aria-label="Search"
              title="Search"
              className={cn(
                'grid h-7 w-7 place-items-center rounded-[var(--radius-md)] text-[var(--text-muted)] transition-colors',
                'hover:bg-[var(--accent)] hover:text-[var(--text-secondary)]',
                focusRing
              )}
            >
              <Search size={16} aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            className={cn(
              'grid h-7 w-7 place-items-center rounded-[var(--radius-md)] text-[var(--text-muted)] transition-colors',
              'hover:bg-[var(--accent)] hover:text-[var(--text-secondary)]',
              focusRing
            )}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} aria-hidden />
            ) : (
              <PanelLeft size={16} aria-hidden />
            )}
          </button>
        </div>
      </div>

      {/* 2 — New chat (text action, not a filled button) */}
      <button
        type="button"
        onClick={handleNewChat}
        title={collapsed ? 'New chat' : undefined}
        className={cn(
          rowBase,
          'mt-2.5 w-full font-medium text-[var(--brand)] hover:bg-[var(--accent)]',
          collapsed && 'justify-center',
          focusRing
        )}
      >
        <PlusCircle size={18} className="shrink-0" aria-hidden />
        {!collapsed && <span>New chat</span>}
      </button>

      {/* 3 — Admin nav, flat */}
      <nav className="mt-1.5 flex shrink-0 flex-col gap-0.5" aria-label="Admin">
        {NAV.filter(canSee).map(({ name, href, Icon }) => {
          const active = isNavActive(href)
          return (
            <Link
              key={href}
              href={href}
              onClick={() => onNavigate?.()}
              title={collapsed ? name : undefined}
              aria-current={active ? 'page' : undefined}
              className={cn(
                rowBase,
                'relative',
                collapsed && 'justify-center',
                active
                  ? 'bg-[color-mix(in_srgb,var(--border)_70%,transparent)] font-medium text-[var(--text)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-[var(--text)]',
                focusRing
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-[var(--brand)]"
                />
              )}
              <Icon size={18} className="shrink-0" aria-hidden />
              {!collapsed && <span className="truncate">{name}</span>}
            </Link>
          )
        })}
      </nav>

      {/* 4 — Divider */}
      {!collapsed && (
        <div className="my-2 h-px shrink-0 bg-[var(--border)]" aria-hidden />
      )}

      {/* 5 — Chat history: the only scrolling region */}
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-hidden">
          {/*
            Mounted whenever the rail is. It used to be gated on
            `isEndpointActive`, which starts FALSE in the store and only flips
            true once initialize() has finished — so on every page load this
            slot rendered nothing at all, and if initialize() was slow or
            failed it stayed blank permanently. "My chat history disappears
            when I refresh" was this.

            Worse, the gate made its own explanation unreachable: Sessions
            renders a skeleton while `isEndpointLoading`, and SessionBlankState
            has a `case !isEndpointActive` that says "Endpoint offline" — both
            written for exactly the states the gate refused to mount them in.
            Sessions owns those states; the parent must not pre-empt them.
          */}
          {mounted && <Sessions />}
        </div>
      )}
      {collapsed && <div className="flex-1" />}

      {/* 6 — Identity + the way out */}
      {mounted && (
        <div className="mt-auto shrink-0 border-t border-[var(--border)] pt-2">
          <div
            className={cn(
              'flex items-center gap-2.5',
              collapsed ? 'flex-col' : 'px-1'
            )}
          >
            <span
              aria-hidden
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--brand)] text-[10px] font-semibold text-[var(--brand-fg)]"
            >
              {user.name[0]?.toUpperCase()}
            </span>
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-[13px] font-medium text-[var(--text)]"
                  title={user.email || user.name}
                >
                  {user.name}
                </p>
              </div>
            )}
            <button
              type="button"
              onClick={handleLogout}
              aria-label="Sign out"
              title="Sign out"
              className={cn(
                'grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--text-muted)] transition-colors',
                'hover:bg-[color-mix(in_srgb,var(--danger-strong)_10%,transparent)] hover:text-[var(--danger-strong)]',
                focusRing
              )}
            >
              <LogOut size={16} aria-hidden />
            </button>
          </div>
          {!collapsed && (
            <p className="mt-1 px-1 text-[10px] text-[var(--text-muted)]">
              Legal Scout{' '}
              {appVersion && (
                // Only the NUMBER is interactive. "Legal Scout" stays plain so
                // this reads as a label containing a link, rather than a whole
                // line of text that turns out to be a button.
                <button
                  type="button"
                  onClick={() => setShowChangelog(true)}
                  title="What's new"
                  className={cn(
                    'tabular-nums underline-offset-2 hover:text-[var(--brand)] hover:underline',
                    focusRing
                  )}
                >
                  v{appVersion}
                </button>
              )}
            </p>
          )}
        </div>
      )}

      {showChangelog && <ChangelogPanel onClose={() => setShowChangelog(false)} />}
    </aside>
  )
}
