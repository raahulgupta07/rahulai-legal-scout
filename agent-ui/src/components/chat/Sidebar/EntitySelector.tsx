'use client'

import * as React from 'react'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { useStore } from '@/store'
import { useQueryState } from 'nuqs'
import { useEffect } from 'react'
import useChatActions from '@/hooks/useChatActions'
import { Bot, Users } from 'lucide-react'
import { Label, Badge, focusRing } from '@/components/ui/kit'
import { cn } from '@/lib/utils'

/**
 * Picking the wrong entity here produces a wrong document, so the trigger
 * always states the live selection in full-strength ink, and an unselected
 * state is called out as a warning rather than left as grey placeholder text.
 */
export function EntitySelector() {
  const { mode, agents, teams, setMessages, setSelectedModel } = useStore()

  const { focusChatInput } = useChatActions()
  const [agentId, setAgentId] = useQueryState('agent', {
    parse: (value) => value || undefined,
    history: 'push'
  })
  const [teamId, setTeamId] = useQueryState('team', {
    parse: (value) => value || undefined,
    history: 'push'
  })
  const [, setSessionId] = useQueryState('session')

  const isTeam = mode === 'team'
  const currentEntities = isTeam ? teams : agents
  const currentValue = isTeam ? teamId : agentId
  const label = isTeam ? 'Team' : 'Agent'
  const EntityIcon = isTeam ? Users : Bot

  const selectedEntity = currentEntities.find((item) => item.id === currentValue)

  useEffect(() => {
    if (currentValue && currentEntities.length > 0) {
      const entity = currentEntities.find((item) => item.id === currentValue)
      if (entity) {
        setSelectedModel(entity.model?.model || '')
        if (mode === 'team') {
          setTeamId(entity.id)
        }
        if (entity.model?.model) {
          focusChatInput()
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentValue, currentEntities, setSelectedModel, mode])

  const handleOnValueChange = (value: string) => {
    const newValue = value === currentValue ? null : value
    const entity = currentEntities.find((item) => item.id === newValue)

    setSelectedModel(entity?.model?.provider || '')

    if (mode === 'team') {
      setTeamId(newValue)
      setAgentId(null)
    } else {
      setAgentId(newValue)
      setTeamId(null)
    }

    setMessages([])
    setSessionId(null)

    if (entity?.model?.provider) {
      focusChatInput()
    }
  }

  const triggerBase = cn(
    'h-9 w-full rounded-[var(--radius-sm)] border px-2.5',
    'text-[length:var(--text-sm)] bg-[var(--surface)] transition-colors',
    focusRing
  )

  if (currentEntities.length === 0) {
    return (
      <div className="w-full">
        <Label className="mb-1">{label}</Label>
        <Select disabled>
          <SelectTrigger
            className={cn(
              triggerBase,
              'border-[var(--border)] text-[var(--text-muted)]'
            )}
          >
            <SelectValue placeholder={`No ${label.toLowerCase()}s available`} />
          </SelectTrigger>
        </Select>
      </div>
    )
  }

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center justify-between gap-2">
        <Label>{label}</Label>
        {!selectedEntity && (
          <Badge tone="warn" dot>
            None selected
          </Badge>
        )}
      </div>
      <Select
        value={currentValue || ''}
        onValueChange={(value) => handleOnValueChange(value)}
      >
        <SelectTrigger
          className={cn(
            triggerBase,
            selectedEntity
              ? 'border-[var(--border-strong)] text-[var(--text)] font-medium'
              : 'border-[var(--warn)] text-[var(--text-muted)]'
          )}
          aria-label={`Selected ${label.toLowerCase()}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <EntityIcon
              className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]"
              aria-hidden
            />
            <SelectValue placeholder={`Choose a ${label.toLowerCase()}…`} />
          </span>
        </SelectTrigger>
        <SelectContent className="border border-[var(--border-strong)] bg-[var(--surface)] rounded-[var(--radius-sm)] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.35)]">
          {currentEntities.map((entity, index) => {
            const active = entity.id === currentValue
            return (
              <SelectItem
                className={cn(
                  'cursor-pointer rounded-[var(--radius-sm)]',
                  active && 'bg-[var(--bg-secondary)]'
                )}
                key={`${entity.id}-${index}`}
                value={entity.id}
              >
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      'truncate text-[length:var(--text-sm)]',
                      active
                        ? 'font-medium text-[var(--text)]'
                        : 'text-[var(--text-secondary)]'
                    )}
                  >
                    {entity.name || entity.id}
                  </span>
                  {entity.model?.model && (
                    <span className="truncate text-[length:var(--text-2xs)] text-[var(--text-muted)]">
                      {entity.model.model}
                    </span>
                  )}
                </span>
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    </div>
  )
}
