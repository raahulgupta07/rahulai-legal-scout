'use client'
import Sidebar from '@/components/chat/Sidebar/Sidebar'
import { ChatArea } from '@/components/chat/ChatArea'
import SplitShell from '@/components/shell/SplitShell'
import ArtifactPanel from '@/components/shell/ArtifactPanel'
import { useArtifact } from '@/components/shell/useArtifact'
import { Suspense, useState } from 'react'
import { Menu } from 'lucide-react'

function Workspace() {
  const hasEnvToken = !!process.env.NEXT_PUBLIC_OS_SECURITY_KEY
  const envToken = process.env.NEXT_PUBLIC_OS_SECURITY_KEY || ''
  const [mobileOpen, setMobileOpen] = useState(false)
  const artifact = useArtifact()

  const mobileHeader = (
    <div className="flex shrink-0 items-center gap-3 border-b-[3px] border-ink bg-background px-3 py-2 md:hidden">
      <button
        onClick={() => setMobileOpen(true)}
        aria-label="Open sessions"
        className="p-1.5 text-ink hover:bg-[color-mix(in_srgb,var(--ink)_10%,transparent)]"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center bg-ink">
          <span className="font-display text-[9px] font-black text-[var(--text-inverse)]">
            LS
          </span>
        </div>
        <span className="font-display text-sm font-black uppercase tracking-brutal text-ink">
          Legal Scout
        </span>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen bg-background">
      {/* Desktop sessions rail — always visible */}
      <div className="hidden md:block">
        <Sidebar hasEnvToken={hasEnvToken} envToken={envToken} />
      </div>

      {/* Mobile sessions rail — overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative h-full w-64 bg-surface">
            <Sidebar hasEnvToken={hasEnvToken} envToken={envToken} />
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <SplitShell
          mobileHeader={mobileHeader}
          artifactBadge={
            artifact ? `${artifact.filled}/${artifact.total}` : null
          }
          chat={<ChatArea />}
          artifact={<ArtifactPanel artifact={artifact} />}
        />
      </div>
    </div>
  )
}

export default function Home() {
  return (
    <Suspense fallback={<div className="h-screen bg-background" />}>
      <Workspace />
    </Suspense>
  )
}
