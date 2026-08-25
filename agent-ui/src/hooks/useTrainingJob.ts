'use client'

/**
 * The server-side template-training job, polled once for the whole app.
 *
 * Training already survives the tab closing — it is a background worker with a
 * DB-backed job row. What it did not survive was the UI: progress only existed
 * inside a modal on the Templates page, so watching it meant standing still on
 * one screen. This store lifts the poll out to the shell, where the tray can
 * report it from anywhere.
 *
 * ONE poller runs, driven by the tray. It ticks fast while a job is live and
 * slowly when idle — the idle tick is what notices a job someone else started,
 * or one the watchdog revived after a restart.
 */

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import apiClient, { authFetch } from '@/lib/api-client'
import { freshSteps, applyStepEvent, type PipelineStep } from '@/app/admin/components/TrainingProgress'

const ACTIVE_MS = 1500
const IDLE_MS = 20000

export interface TrainingJob {
  status: 'idle' | 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  current_template?: string
  current_index?: number
  total?: number
  done_count?: number
  fail_count?: number
  error?: string
  logs?: any[]
  updated_at?: string
}

interface TrainingJobState {
  job: TrainingJob | null
  setJob: (job: TrainingJob | null) => void
}

export const useTrainingJob = create<TrainingJobState>((set) => ({
  job: null,
  setJob: (job) => set({ job }),
}))

export const isTrainingActive = (job: TrainingJob | null) =>
  job?.status === 'running' || job?.status === 'queued'

/**
 * Rebuilds the current template's step list from the job's log tail, the same
 * fold the Templates modal does — so the tray and the modal cannot disagree.
 */
export function stepsFromJob(job: TrainingJob | null): PipelineStep[] {
  let pipe = freshSteps()
  for (const e of job?.logs || []) {
    if (e?.step === 'template_start') pipe = freshSteps()
    else pipe = applyStepEvent(pipe, e?.step || '', e?.msg || '')
  }
  return pipe
}

export interface TrainingSummary {
  active: boolean
  total: number
  finished: number
  failed: number
  /** 1-based position of the template being worked on. */
  index: number
  templateName: string
  /** Steps done on the CURRENT template, 0-100. */
  stepPct: number
  stepsDone: number
  stepsTotal: number
  /** Whole-queue percentage, counting the current template's part-progress. */
  pct: number
  label: string
}

export function trainingSummary(job: TrainingJob | null, steps: PipelineStep[]): TrainingSummary {
  const status = job?.status || 'idle'
  const active = isTrainingActive(job)
  const total = job?.total || 0
  const done = job?.done_count || 0
  const failed = job?.fail_count || 0
  const finished = done + failed
  const index = status === 'done' ? total : Math.min((job?.current_index || 0) + 1, total || 1)

  const stepsTotal = steps.length
  const stepsDone = steps.filter((s) => s.status === 'done' || s.status === 'warn').length
  const stepPct = stepsTotal ? Math.round((stepsDone / stepsTotal) * 100) : 0

  // Whole-queue progress. The template in flight counts as a fraction, not as
  // nothing — otherwise a single long template reads as a frozen bar.
  let pct = 0
  if (total > 0) {
    const fraction = active && stepsTotal ? stepsDone / stepsTotal : 0
    pct = Math.min(100, Math.round(((finished + (active ? fraction : 0)) / total) * 100))
    if (!active && (status === 'done' || status === 'cancelled' || status === 'error')) {
      pct = Math.round((finished / total) * 100)
    }
  }

  const label =
    status === 'done'
      ? `Trained ${done} of ${total}`
      : status === 'cancelled'
        ? 'Training cancelled'
        : status === 'error'
          ? 'Training failed'
          : active
            ? `Training ${index} of ${total}`
            : 'No training run'

  return { active, total, finished, failed, index, templateName: job?.current_template || '', stepPct, stepsDone, stepsTotal, pct, label }
}

// Set by the mounted poller; lets a caller that JUST started a job pull the
// first status immediately instead of waiting out the idle interval.
let kick: (() => void) | null = null

/** Poll the training job now, if a poller is mounted. Safe to call anywhere. */
export function kickTrainingPoll() {
  kick?.()
}

/**
 * Single poller for the whole app. Mount from the tray only — a second caller
 * would double the request rate without changing what anyone sees.
 */
export function useTrainingJobPoller() {
  const setJob = useTrainingJob((s) => s.setJob)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aliveRef = useRef(true)
  // The endpoint returns the MOST RECENT job, not a recent one — a run that
  // finished last week comes back looking like news. So a finished run is only
  // reported once this page has watched it run. Deliberately not a timestamp
  // comparison: the job row is stamped by Postgres and the cutoff would be
  // read against the browser's clock, which is a wrong answer waiting for a
  // timezone rather than a rule.
  const sawActiveRef = useRef(false)

  useEffect(() => {
    aliveRef.current = true

    const tick = async () => {
      if (!aliveRef.current) return
      let delay = IDLE_MS
      try {
        const res = await authFetch(apiClient.trainJob())
        if (res.ok) {
          const job = await res.json()
          const live: TrainingJob | null = !job || job.status === 'idle' ? null : job
          const active = isTrainingActive(live)
          if (active) sawActiveRef.current = true
          setJob(active || sawActiveRef.current ? live : null)
          if (active) delay = ACTIVE_MS
        }
      } catch (e) {
        // A failed poll must not kill the loop — the job runs server-side and
        // will still be there on the next tick.
        console.error('Training poll failed:', e)
      }
      if (aliveRef.current) timerRef.current = setTimeout(tick, delay)
    }

    kick = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      tick()
    }

    tick()
    return () => {
      aliveRef.current = false
      kick = null
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [setJob])
}
