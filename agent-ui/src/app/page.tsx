'use client'
import { ChatArea } from '@/components/chat/ChatArea'
import SplitShell from '@/components/shell/SplitShell'
import ArtifactPanel from '@/components/shell/ArtifactPanel'
import { useArtifact } from '@/components/shell/useArtifact'
import { useStore } from '@/store'
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

  // An explicit "View" on a document card always opens the panel, even after
  // the user closed it — they just asked to see that file.
  const previewRequest = useStore((s) => s.previewRequest)
  useEffect(() => {
    if (!previewRequest) return
    userClosedRef.current = false
    setPanelOpen(true)
  }, [previewRequest])

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
      <div className="min-w-0 flex-1">
        <SplitShell
          artifactBadge={
            artifact ? `${artifact.filled}/${artifact.total}` : null
          }
          artifactHidden={!panelOpen}
          onToggleArtifact={togglePanel}
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
