'use client'

import { useState } from 'react'

import PickerCard from './PickerCard'
import useAIChatStreamHandler from '@/hooks/useAIStreamHandler'
import type { PickerRequest, PickerSelectionEntry } from '@/types/os'

/**
 * Renders every outstanding picker requirement carried by one message.
 *
 * A single RunPaused event can carry more than one paused tool, so N cards are
 * rendered. Only one can be answered: resuming the run consumes the pause, so
 * the remaining cards are locked while a submit is in flight and the backend
 * re-pauses for whatever is still outstanding.
 */
const PickerCardList = ({ requests }: { requests?: PickerRequest[] }) => {
  const { continueRun } = useAIChatStreamHandler()
  const [busy, setBusy] = useState(false)

  if (!requests?.length) return null

  const handleSubmit = async (
    request: PickerRequest,
    selection: PickerSelectionEntry | PickerSelectionEntry[]
  ) => {
    setBusy(true)
    try {
      await continueRun(request, selection)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {requests.map((request) => (
        <PickerCard
          key={request.tool_call_id}
          request={request}
          onSubmit={handleSubmit}
          disabled={busy && request.status === 'pending'}
        />
      ))}
    </div>
  )
}

export default PickerCardList
