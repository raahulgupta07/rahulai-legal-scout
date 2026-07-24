"use client"

import { cn } from "@/lib/utils"
import { focusRing } from "@/components/ui/kit"

export interface AdminTab {
  id: string
  label: string
}

/**
 * Insights-style segmented tab bar for the consolidated admin pages.
 * Active tab background uses color-mix (never a Tailwind alpha modifier on a
 * var() colour — those emit nothing).
 */
export function AdminTabs({
  tabs,
  active,
  onSelect,
  ariaLabel,
}: {
  tabs: AdminTab[]
  active: string
  onSelect: (id: string) => void
  ariaLabel: string
}) {
  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-2.5">
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="inline-flex border border-[var(--border)] rounded-lg p-0.5 gap-0.5"
      >
        {tabs.map((t) => {
          const on = t.id === active
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              onClick={() => onSelect(t.id)}
              className={cn(
                "text-[13px] px-3 py-1.5 rounded-md transition-colors",
                on
                  ? "text-[var(--text)] font-medium"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]",
                focusRing
              )}
              style={on ? { background: "color-mix(in srgb, var(--border) 70%, transparent)" } : undefined}
            >
              {t.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
