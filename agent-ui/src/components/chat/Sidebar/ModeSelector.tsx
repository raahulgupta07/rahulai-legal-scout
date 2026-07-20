'use client'

import * as React from 'react'
import { useStore } from '@/store'
import { useQueryState } from 'nuqs'
import useChatActions from '@/hooks/useChatActions'
import { Label, Segmented } from '@/components/ui/kit'

/**
 * Two options only, so a dropdown is the wrong control: it hides half the
 * choice behind a click and renders the live one as plain text. A segmented
 * control shows both and marks which one the next run will use.
 */
export function ModeSelector() {
  const { mode, setMode, setMessages, setSelectedModel } = useStore()
  const { clearChat } = useChatActions()
  const [, setAgentId] = useQueryState('agent')
  const [, setTeamId] = useQueryState('team')
  const [, setSessionId] = useQueryState('session')

  const handleModeChange = (newMode: 'agent' | 'team') => {
    if (newMode === mode) return

    setMode(newMode)

    setAgentId(null)
    setTeamId(null)
    setSelectedModel('')
    setMessages([])
    setSessionId(null)
    clearChat()
  }

  return (
    <div className="w-full">
      <Label className="mb-1">Mode</Label>
      <Segmented<'agent' | 'team'>
        label="Run against a single agent or a team"
        value={mode === 'team' ? 'team' : 'agent'}
        onChange={handleModeChange}
        options={[
          { value: 'agent', label: 'Agent' },
          { value: 'team', label: 'Team' }
        ]}
      />
    </div>
  )
}
