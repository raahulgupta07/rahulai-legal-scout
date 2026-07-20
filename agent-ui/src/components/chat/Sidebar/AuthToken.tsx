'use client'
import { useStore } from '@/store'
import { useState, useEffect } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { Label, Input, Button, IconButton, Badge } from '@/components/ui/kit'

/**
 * The previous version swapped its own contents on hover to reveal that it was
 * editable — invisible to keyboard and touch, and it hid the value it was
 * meant to show. Now the value is always shown masked, with an explicit Edit.
 */
const AuthToken = ({
  hasEnvToken,
  envToken
}: {
  hasEnvToken?: boolean
  envToken?: string
}) => {
  const { authToken, setAuthToken } = useStore()
  const [isEditing, setIsEditing] = useState(false)
  const [tokenValue, setTokenValue] = useState('')
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    // Initialize with environment variable if available and no token is set
    if (hasEnvToken && envToken && !authToken) {
      setAuthToken(envToken)
      setTokenValue(envToken)
    } else {
      setTokenValue(authToken)
    }
    setIsMounted(true)
  }, [authToken, setAuthToken, hasEnvToken, envToken])

  const handleSave = () => {
    setAuthToken(tokenValue.trim())
    setIsEditing(false)
  }

  const handleCancel = () => {
    setTokenValue(authToken)
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSave()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }

  const hasToken = isMounted && Boolean(authToken)

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center justify-between gap-2">
        <Label>Auth token</Label>
        <Badge tone={hasToken ? 'ok' : 'neutral'} dot>
          {hasToken ? 'Set' : 'Not set'}
        </Badge>
      </div>

      {isEditing ? (
        <div className="flex items-center gap-1">
          <Input
            type="password"
            value={tokenValue}
            onChange={(e) => setTokenValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Paste token…"
            aria-label="Authentication token"
            autoFocus
            className="h-8 py-0 text-[length:var(--text-xs)]"
          />
          <IconButton
            aria-label="Save token"
            title="Save token"
            onClick={handleSave}
            icon={<Check className="h-3.5 w-3.5" />}
          />
          <IconButton
            aria-label="Cancel"
            title="Cancel"
            onClick={handleCancel}
            icon={<X className="h-3.5 w-3.5" />}
          />
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <p className="min-w-0 flex-1 truncate border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[length:var(--text-xs)] text-[var(--text-muted)] rounded-[var(--radius-sm)]">
            {hasToken ? '•'.repeat(Math.min(authToken.length, 24)) : 'No token'}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setIsEditing(true)}
            icon={<Pencil className="h-3 w-3" />}
          >
            Edit
          </Button>
        </div>
      )}
    </div>
  )
}

export default AuthToken
