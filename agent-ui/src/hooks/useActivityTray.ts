'use client'

/**
 * Which channel the docked activity tray is showing, and whether it is up.
 *
 * There is ONE tray for every kind of background work — imports, template
 * training, queued email — because an operator running a bulk import while a
 * training job finishes should not have to hunt two corners of two different
 * pages for the answer. The channels differ; the place they report to does not.
 *
 * Visibility is not a stored `open` flag but the absence of a dismissal: the
 * tray shows whenever a channel has something to say, and hiding it hides the
 * panel without cancelling anything. NEW work revives it — a dismissal answers
 * for the work the operator saw, not for work that arrives afterwards.
 *
 * Kept outside React's tree (a plain zustand store, mounted once by AppShell)
 * so the tray survives every chat↔admin navigation without a remount.
 */

import { create } from 'zustand'

export type ActivityTab = 'imports' | 'training' | 'email'

interface ActivityTrayState {
  tab: ActivityTab
  dismissed: boolean
  collapsed: boolean
  /** True once the operator has picked a tab by hand — stops auto-switching. */
  pinned: boolean
  /**
   * Shows the tray before any channel has data to report. Starting a training
   * job is the case: the button is clicked, but the job does not exist for the
   * poller until its first tick, and a tray that appears a beat later reads as
   * a button that did nothing.
   */
  forced: boolean
  setTab: (tab: ActivityTab) => void
  /** Auto-selection: only moves while the operator has not chosen a tab. */
  suggestTab: (tab: ActivityTab) => void
  /** Show the tray on a given channel, e.g. when training is started. */
  openTab: (tab: ActivityTab) => void
  dismiss: () => void
  revive: () => void
  setCollapsed: (collapsed: boolean) => void
}

export const useActivityTray = create<ActivityTrayState>((set) => ({
  tab: 'imports',
  dismissed: false,
  collapsed: false,
  pinned: false,
  forced: false,

  setTab: (tab) => set({ tab, pinned: true }),
  suggestTab: (tab) => set((s) => (s.pinned || s.tab === tab ? {} : { tab })),
  openTab: (tab) => set({ tab, dismissed: false, collapsed: false, pinned: true, forced: true }),
  // A dismissal also releases the pin: the next batch should pick its own tab.
  dismiss: () => set({ dismissed: true, pinned: false, forced: false }),
  revive: () => set({ dismissed: false }),
  setCollapsed: (collapsed) => set({ collapsed }),
}))
