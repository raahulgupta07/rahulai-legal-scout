'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useState, useEffect } from 'react'
import {
  LayoutDashboard,
  FileText,
  Users,
  Contact,
  FolderOpen,
  Brain,
  MessageCircle,
  ChevronLeft,
  ChevronRight,
  Mail,
  Shield,
  LogOut,
  Settings
} from 'lucide-react'
import { useRouter } from 'next/navigation'

interface NavItem {
  name: string
  href: string
  icon: React.ReactNode
}

const navItems: NavItem[] = [
  { name: 'Dashboard', href: '/admin/dashboard', icon: <LayoutDashboard className="w-5 h-5" /> },
  { name: 'Documents', href: '/admin/documents', icon: <FileText className="w-5 h-5" /> },
  { name: 'Emails', href: '/admin/emails', icon: <Mail className="w-5 h-5" /> },
  { name: 'Templates', href: '/admin/templates', icon: <FolderOpen className="w-5 h-5" /> },
  { name: 'Companies', href: '/admin/companies', icon: <Users className="w-5 h-5" /> },
  { name: 'People', href: '/admin/people', icon: <Contact className="w-5 h-5" /> },
  { name: 'Knowledge', href: '/admin/knowledge', icon: <Brain className="w-5 h-5" /> },
  { name: 'Users', href: '/admin/users', icon: <Shield className="w-5 h-5" /> },
  { name: 'Settings', href: '/admin/settings', icon: <Settings className="w-5 h-5" /> },
]

export default function DashboardSidebar() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [activeTab, setActiveTab] = useState("dashboard")
  const [userRole, setUserRole] = useState("user")

  useEffect(() => {
    try {
      const raw = localStorage.getItem("ls_user")
      if (raw) setUserRole(JSON.parse(raw).role || "user")
    } catch {}
  }, [])

  useEffect(() => {
    const currentPath = pathname || '/admin/dashboard'
    const path = currentPath.replace(/\/$/, '')
    if (path === '/admin/dashboard') setActiveTab('dashboard')
    else if (path === '/admin/documents') setActiveTab('documents')
    else if (path.startsWith('/admin/emails')) setActiveTab('emails')
    else if (path.startsWith('/admin/templates')) setActiveTab('templates')
    else if (path.startsWith('/admin/companies')) setActiveTab('companies')
    else if (path.startsWith('/admin/people')) setActiveTab('people')
    else if (path.startsWith('/admin/knowledge')) setActiveTab('knowledge')
    else if (path.startsWith('/admin/users')) setActiveTab('users')
    else if (path.startsWith('/admin/settings')) setActiveTab('settings')
  }, [pathname, searchParams])

  const isActive = (href: string) => {
    const tab = href.replace('/admin/', '')
    return activeTab === tab
  }

  return (
    <div className={`brutalist flex flex-col h-full bg-[#feffd6] border-r-[3px] border-[#383832] ${collapsed ? 'w-20' : 'w-64'} transition-all duration-300 font-brutalist`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b-[3px] border-[#383832]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-[#383832] flex items-center justify-center shrink-0">
            <span className="text-[#feffd6] font-black text-sm">LS</span>
          </div>
          {!collapsed && (
            <span className="text-sm font-black text-[#383832] uppercase tracking-wider">Legal Scout</span>
          )}
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 hover:bg-[#383832]/10 text-[#383832] transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* Back to Chat */}
      <div className="p-3 border-b-[2px] border-[#383832]">
        <Link
          href="/"
          className="flex items-center gap-3 px-3 py-2.5 text-sm font-black bg-[#007518] text-white uppercase tracking-wider
                     hover:bg-[#005c13] transition-all ink-border stamp-press"
        >
          <MessageCircle className="w-5 h-5" />
          {!collapsed && <span>Legal Scout</span>}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {!collapsed && (
          <div className="px-3 py-2">
            <span className="tag-label">Dashboard</span>
          </div>
        )}
        {navItems.filter(item => {
          if (item.name === 'Users' || item.name === 'Settings') return userRole === 'admin'
          if (['Templates', 'Companies', 'People', 'Knowledge'].includes(item.name)) return userRole !== 'user'
          return true
        }).map((item) => {
          const isItemActive = isActive(item.href)
          return (
            <button
              key={item.name}
              onClick={() => router.push(item.href)}
              className={`flex items-center gap-3 px-3 py-2.5 text-sm font-bold transition-all w-full uppercase tracking-wider cursor-pointer ${
                isItemActive
                  ? 'bg-[#383832] text-[#feffd6] ink-border stamp-shadow'
                  : 'text-[#383832] hover:bg-[#383832]/10'
              }`}
            >
              {item.icon}
              {!collapsed && <span>{item.name}</span>}
            </button>
          )
        })}
      </nav>

      {/* Profile + Logout */}
      <div className="p-3 border-t-[3px] border-[#383832]">
        {!collapsed && (() => {
          let userName = "User"
          try {
            const raw = localStorage.getItem("ls_user")
            if (raw) { const u = JSON.parse(raw); userName = u.name || u.email?.split("@")[0] || "User" }
          } catch {}
          return (
            <div className="flex items-center gap-2.5 px-3 py-2 mb-2">
              <div className="w-8 h-8 bg-[#383832] flex items-center justify-center shrink-0">
                <span className="text-[#feffd6] text-xs font-black">{userName[0]?.toUpperCase()}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-[#383832] truncate">{userName}</p>
                <span className="tag-label">{userRole}</span>
              </div>
            </div>
          )
        })()}
        <button
          onClick={() => { localStorage.removeItem("ls_token"); localStorage.removeItem("ls_user"); window.location.href = "/login" }}
          className="flex items-center gap-3 px-3 py-2.5 text-sm font-black text-[#be2d06] uppercase tracking-wider hover:bg-[#be2d06]/10 w-full transition-colors cursor-pointer"
        >
          <LogOut className="w-5 h-5" />
          {!collapsed && <span>Logout</span>}
        </button>
      </div>
    </div>
  )
}
