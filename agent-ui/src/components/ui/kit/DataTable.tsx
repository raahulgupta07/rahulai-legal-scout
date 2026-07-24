'use client'

import * as React from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { focusRing } from './Button'

export interface Column<T> {
  /** Stable identity, and the default sort key. */
  key: string
  header: React.ReactNode
  /** Cell contents. Omit for a plain `row[key]` read. */
  render?: (row: T, index: number) => React.ReactNode
  /**
   * Return a comparable primitive to make the column sortable. Sorting is
   * client-side; a column without this is not offered as a sort target.
   */
  sortValue?: (row: T) => string | number | null | undefined
  align?: 'left' | 'right' | 'center'
  /** Right-aligns and applies tabular figures so digits line up down the column. */
  numeric?: boolean
  /** Drops the column on narrow viewports rather than forcing a sideways scroll. */
  hideBelow?: 'sm' | 'md' | 'lg'
  width?: string
  /** Suppresses the row-level onClick — use on the actions column. */
  stopClickPropagation?: boolean
}

const HIDE: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell'
}

type SortDir = 'asc' | 'desc'

/**
 * Dense, scannable table.
 *
 * The scroll container is the table's own wrapper (`overflow-x-auto`), never
 * the page — a wide table must not make the whole document scroll sideways.
 * The header is sticky so column meaning survives a long list.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading = false,
  empty,
  caption,
  /** Optional severity accent per row, painted as a left stripe. */
  rowTone,
  className,
  maxHeight
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string | number
  onRowClick?: (row: T) => void
  loading?: boolean
  empty?: React.ReactNode
  caption?: React.ReactNode
  rowTone?: (row: T) => string | null
  className?: string
  maxHeight?: string
}) {
  const [sortKey, setSortKey] = React.useState<string | null>(null)
  const [sortDir, setSortDir] = React.useState<SortDir>('asc')

  const sorted = React.useMemo(() => {
    const col = columns.find((c) => c.key === sortKey)
    if (!col?.sortValue) return rows
    const dir = sortDir === 'asc' ? 1 : -1
    // Copy first: Array.prototype.sort mutates, and `rows` is the caller's state.
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a)
      const bv = col.sortValue!(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1 // blanks sink, in both directions
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir
    })
  }, [rows, columns, sortKey, sortDir])

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  return (
    <div
      className={cn(
        'border border-[var(--border)] bg-[var(--surface)] rounded-[var(--radius-lg)] overflow-x-auto',
        className
      )}
      style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}
    >
      <table className="w-full border-collapse text-[length:var(--text-sm)]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="sticky top-0 z-10">
          <tr className="bg-[var(--bg-secondary)]">
            {columns.map((c) => {
              const sortable = !!c.sortValue
              const active = sortKey === c.key
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    'border-b border-[var(--border)] px-3.5 py-2.5 font-semibold',
                    'text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-tag)] text-[var(--text-muted)]',
                    c.numeric || c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.hideBelow && HIDE[c.hideBelow]
                  )}
                  aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={cn(
                        'inline-flex items-center gap-1 uppercase tracking-[var(--tracking-tag)]',
                        'hover:text-[var(--text)] transition-colors',
                        active && 'text-[var(--text)]',
                        focusRing
                      )}
                    >
                      {c.header}
                      {active ? (
                        sortDir === 'asc' ? (
                          <ArrowUp className="w-3 h-3" />
                        ) : (
                          <ArrowDown className="w-3 h-3" />
                        )
                      ) : (
                        <ChevronsUpDown className="w-3 h-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-[var(--text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                Loading…
              </td>
            </tr>
          ) : sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center">
                {empty ?? <span className="text-[var(--text-muted)]">Nothing to show.</span>}
              </td>
            </tr>
          ) : (
            sorted.map((row, i) => {
              const tone = rowTone?.(row)
              return (
                <tr
                  key={rowKey(row, i)}
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onRowClick(row)
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    'border-b border-[var(--border)] last:border-b-0 transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-[var(--bg-secondary)]',
                    onRowClick && focusRing
                  )}
                  style={tone ? { boxShadow: `inset 3px 0 0 0 ${tone}` } : undefined}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      onClick={c.stopClickPropagation ? (e) => e.stopPropagation() : undefined}
                      className={cn(
                        'px-3.5 py-2.5 align-middle text-[var(--text-secondary)]',
                        c.numeric && 'text-right tabular-nums',
                        !c.numeric && c.align === 'right' && 'text-right',
                        c.align === 'center' && 'text-center',
                        c.hideBelow && HIDE[c.hideBelow]
                      )}
                    >
                      {c.render ? c.render(row, i) : ((row as Record<string, unknown>)[c.key] as React.ReactNode) ?? '—'}
                    </td>
                  ))}
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
