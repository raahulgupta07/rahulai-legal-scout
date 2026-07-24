'use client'
import { ChatArea } from '@/components/chat/ChatArea'
import SplitShell from '@/components/shell/SplitShell'
import ArtifactPanel from '@/components/shell/ArtifactPanel'
import { useArtifact } from '@/components/shell/useArtifact'
import { Suspense } from 'react'

function Workspace() {
  const artifact = useArtifact()

  // The left rail now comes from the root AppShell; this surface is just the
  // conversation + artifact split.
  return (
    <div className="flex h-full bg-background">
      <div className="min-w-0 flex-1">
        <SplitShell
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
