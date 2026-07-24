'use client'
import { ChatArea } from '@/components/chat/ChatArea'
import SplitShell from '@/components/shell/SplitShell'
import ArtifactPanel from '@/components/shell/ArtifactPanel'
import { useArtifact } from '@/components/shell/useArtifact'
import { useStore } from '@/store'
import { Columns2 } from 'lucide-react'
import { Suspense, useEffect, useRef, useState } from 'react'

function Workspace() {
  const artifact = useArtifact()

  // A run is document work when a document tool is actually executing —
  // ordinary Q&A must not summon the pane.
  const docWorkLive = useStore((s) => {
    if (!s.isStreaming) return false
    const last = s.messages[s.messages.length - 1]
    if (!last || last.role !== 'agent') return false
    return (last.tool_calls ?? []).some((tc) =>
      /^(prepare_document|generate_document|preview_document|create_document)/.test(
        tc.tool_name ?? ''
      )
    )
  })

  // bagofwords behaviour: the pane stays closed until document work starts,
  // then opens itself. A manual close is respected until the NEXT document
  // appears; the toggle button always works.
  const [panelOpen, setPanelOpen] = useState(false)
  const userClosedRef = useRef(false)
  const hasDocSignal = Boolean(artifact) || docWorkLive
  useEffect(() => {
    if (hasDocSignal && !userClosedRef.current) setPanelOpen(true)
    if (!hasDocSignal) userClosedRef.current = false
  }, [hasDocSignal])

  const togglePanel = () => {
    setPanelOpen((open) => {
      // Only a close on an ACTIVE document counts as "leave it closed" —
      // closing an empty panel must not suppress the next auto-open.
      if (open && hasDocSignal) userClosedRef.current = true
      return !open
    })
  }

  return (
    <div className="relative flex h-full bg-background">
      <button
        type="button"
        onClick={togglePanel}
        aria-pressed={panelOpen}
        title={panelOpen ? 'Hide document panel' : 'Show document panel'}
        className={`absolute right-3 top-3 z-30 grid h-7 w-7 place-items-center rounded-md transition-colors ${
          panelOpen
            ? 'bg-[color-mix(in_srgb,var(--border)_70%,transparent)] text-[var(--text)]'
            : 'text-[var(--faint)] hover:bg-[var(--accent)] hover:text-[var(--text-muted)]'
        }`}
      >
        <Columns2 className="h-[18px] w-[18px]" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        <SplitShell
          artifactBadge={
            artifact ? `${artifact.filled}/${artifact.total}` : null
          }
          artifactHidden={!panelOpen}
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
