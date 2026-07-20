'use client'

import { Plus } from 'lucide-react'
import useChatActions from '@/hooks/useChatActions'
import { useStore } from '@/store'
import { Button } from '@/components/ui/kit'

/**
 * The one accented action in the sidebar. It carries the brand fill precisely
 * because nothing else here does — the moment a second control competes for
 * the same weight, neither reads as primary.
 */
function NewChatButton({ onClick }: { onClick?: () => void }) {
  const { clearChat } = useChatActions()
  const { messages } = useStore()

  return (
    <Button
      variant="primary"
      className="w-full justify-center"
      onClick={onClick ?? clearChat}
      disabled={messages.length === 0}
      icon={<Plus className="h-4 w-4" aria-hidden />}
    >
      New chat
    </Button>
  )
}

export default NewChatButton
