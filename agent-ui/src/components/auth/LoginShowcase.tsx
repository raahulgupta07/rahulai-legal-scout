'use client'

/**
 * Live agent showcase on the login page — Legal Scout's document pipeline
 * animated on a loop. Visual language matches the CityAgent Insights sign-in
 * (dark navy rounded panel, LIVE badge, outlined pill steps, connector tiles).
 * Pure presentation: no data, no requests.
 */

import { useEffect, useRef } from 'react'

const STEPS = [
  'UNDERSTAND',
  'TEMPLATE',
  'REGISTER',
  'SIGNER',
  'DRAFT',
  'REVIEW'
] as const

const QUESTION =
  'Prepare the Corporate Shareholder Consent for Arctic Sun — who signs?'

function pill(label: string, state: 'on' | 'done' | 'off'): string {
  const st =
    state === 'on'
      ? 'border:1px solid #3B82F6;color:#DBEAFE;background:rgba(37,99,235,.13)'
      : state === 'done'
        ? 'border:1px solid #1E3A5F;color:#7DA6D9;background:transparent'
        : 'border:1px solid rgba(255,255,255,.08);color:#64748B;background:transparent'
  const dot = state === 'on' ? '#3B82F6' : state === 'done' ? '#22C55E' : '#334155'
  return `<span style="display:inline-flex;align-items:center;gap:7px;font-size:9.5px;letter-spacing:.02em;font-weight:600;border-radius:9999px;padding:3px 8px;${st}"><span style="width:6px;height:6px;border-radius:9999px;background:${dot}"></span>${label}</span>`
}

const pipeHtml = (i: number) =>
  STEPS.map((s, k) => pill(s, k < i ? 'done' : k === i ? 'on' : 'off')).join('')

const head = (t: string) =>
  `<div style="display:flex;align-items:center;gap:8px;font-size:10.5px;letter-spacing:.1em;color:#7DA6D9;font-weight:600;margin-bottom:12px"><span style="width:7px;height:7px;border-radius:9999px;background:#3B82F6"></span>${t}</div>`

function tile(
  abbr: string,
  color: string,
  name: string,
  sub: string,
  dim?: boolean
): string {
  return `<div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px 12px;text-align:center;background:rgba(255,255,255,.024);opacity:${dim ? '0.45' : '1'}">
    <div style="width:40px;height:40px;border-radius:9px;background:${color};display:grid;place-items:center;margin:0 auto 10px;font-size:13px;font-weight:700;color:#fff">${abbr}</div>
    <div style="font-size:12.5px;font-weight:600;color:#E2E8F0">${name}</div><div style="font-size:11px;color:#64748B;margin-top:2px">${sub}</div></div>`
}

function stageHtml(kind: string): string {
  if (kind === 'tpl')
    return (
      head('MATCHING TEMPLATE') +
      `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">` +
      tile('TPL', '#2563EB', 'Templates', '15 trained') +
      tile('REG', '#0EA5E9', 'Company register', 'DICA data') +
      tile('PPL', '#8B5CF6', 'People register', 'signers', true) +
      tile('SKL', '#22C55E', 'Legal playbooks', '12 skills', true) +
      `</div><div style="margin-top:14px;border:1px solid #2563EB;border-radius:10px;padding:10px 14px;font-size:13px;color:#DBEAFE;background:rgba(37,99,235,.08)">Corporate Shareholder Consent — Directors Resolution &nbsp;<span style="color:#22C55E">✓ matched</span></div>`
    )
  if (kind === 'reg')
    return (
      head('READING COMPANY REGISTER') +
      `<div style="border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px;font-size:13px;line-height:2;background:rgba(255,255,255,.024)">ARCTIC SUN COMPANY LIMITED · 101687465<br>Holding member: <b style="color:#DBEAFE">PAHTAMA GROUP CO. LTD</b> — 51,000 ORD<br><span style="color:#F59E0B">⚖ Playbook: the corporate shareholder&#39;s own directors sign — never Arctic Sun&#39;s board</span></div>`
    )
  if (kind === 'sign')
    return (
      head('SIGNER — PICKED IN CHAT') +
      `<div style="border:1px solid #3B82F6;border-radius:12px;padding:13px 16px;font-size:13.5px;color:#DBEAFE;background:rgba(37,99,235,.08)">◉ Director of Pahtama Group <span style="color:#64748B">(chosen from the picker card)</span></div>`
    )
  if (kind === 'draft') {
    let bars = ''
    for (let i = 0; i < 12; i++)
      bars += `<span class="lsc-bar" style="flex:1;height:9px;border-radius:4px;background:#1E293B"></span>`
    return (
      head('FILLING 12 FIELDS') +
      `<div style="display:flex;gap:5px">${bars}</div><div id="lsc-count" style="margin-top:12px;font-size:30px;font-weight:700;color:#F1F5F9">0/12</div>`
    )
  }
  if (kind === 'done')
    return `<div style="border:1px solid rgba(34,197,94,.33);border-radius:14px;padding:18px;background:rgba(34,197,94,.07)"><div style="font-size:11.5px;letter-spacing:.1em;color:#6EE7A8;font-weight:600">DRAFT READY — ATTORNEY REVIEW</div><div style="font-size:15px;font-weight:600;margin-top:7px;color:#F1F5F9">📄 Corporate_Shareholder_Consent_ARCTIC_SUN.docx</div><div style="font-size:12.5px;color:#94A3B8;margin-top:5px">12/12 fields · DICA Form C due within 28 days</div></div>`
  return ''
}

export default function LoginShowcase() {
  const qRef = useRef<HTMLDivElement>(null)
  const pipeRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const elRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let mounted = true
    const timers: ReturnType<typeof setTimeout>[] = []
    const intervals: ReturnType<typeof setInterval>[] = []
    const later = (fn: () => void, ms: number) => {
      timers.push(setTimeout(() => mounted && fn(), ms))
    }
    let t0 = Date.now()
    intervals.push(
      setInterval(() => {
        if (elRef.current)
          elRef.current.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's'
      }, 100)
    )

    const type = (el: HTMLElement, txt: string, sp: number, done: () => void) => {
      let c = 0
      const tick = () => {
        if (!mounted) return
        el.innerHTML =
          txt.slice(0, c) +
          (c < txt.length
            ? '<span style="display:inline-block;width:2px;height:1em;background:#3B82F6;vertical-align:-2px"></span>'
            : '')
        c++
        if (c <= txt.length) timers.push(setTimeout(tick, sp))
        else done()
      }
      tick()
    }

    const loop = () => {
      if (!mounted || !qRef.current || !pipeRef.current || !stageRef.current)
        return
      const [q, pipe, stage] = [qRef.current, pipeRef.current, stageRef.current]
      q.innerHTML = ''
      stage.innerHTML = ''
      pipe.innerHTML = pipeHtml(0)
      t0 = Date.now()
      type(q, QUESTION, 18, () => {
        later(() => {
          pipe.innerHTML = pipeHtml(1)
          stage.innerHTML = stageHtml('tpl')
        }, 400)
        later(() => {
          pipe.innerHTML = pipeHtml(2)
          stage.innerHTML = stageHtml('reg')
        }, 2600)
        later(() => {
          pipe.innerHTML = pipeHtml(3)
          stage.innerHTML = stageHtml('sign')
        }, 4900)
        later(() => {
          pipe.innerHTML = pipeHtml(4)
          stage.innerHTML = stageHtml('draft')
          let i = 0
          const iv = setInterval(() => {
            const bars = stage.querySelectorAll<HTMLElement>('.lsc-bar')
            const count = stage.querySelector<HTMLElement>('#lsc-count')
            if (i < 12 && bars[i]) {
              bars[i].style.background = '#22C55E'
              i++
              if (count) count.textContent = `${i}/12`
            } else clearInterval(iv)
          }, 130)
          intervals.push(iv)
        }, 6500)
        later(() => {
          pipe.innerHTML = pipeHtml(5)
          stage.innerHTML = stageHtml('done')
        }, 9000)
        later(loop, 12500)
      })
    }
    loop()

    return () => {
      mounted = false
      timers.forEach(clearTimeout)
      intervals.forEach(clearInterval)
    }
  }, [])

  return (
    <div
      className="relative flex min-h-[620px] w-full flex-col overflow-hidden rounded-[22px] px-[33px] pb-5 pt-[21px] text-[#E2E8F0]"
      style={{
        background: 'radial-gradient(120% 120% at 82% -12%, #1E3A8A 0%, #0F1E3D 52%, #0A1226 100%)'
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute"
        style={{
          width: 420,
          height: 420,
          borderRadius: 9999,
          background: 'radial-gradient(circle,rgba(37,99,235,.17),transparent 65%)',
          bottom: -160,
          left: -100
        }}
      />
      <div className="flex items-center gap-2.5">
        <span className="rounded-[6px] bg-[#2563EB] px-2 py-[2px] text-[10.5px] font-bold tracking-[.08em] text-white">
          LIVE
        </span>
        <span className="text-[13px] text-[#CBD5E1]">
          Legal Scout is working on your task
        </span>
        <span ref={elRef} className="ml-auto text-[12px] text-[#64748B]">
          0.0s
        </span>
      </div>
      <div
        ref={qRef}
        className="mt-[9px] min-h-[44px] rounded-[11px] border border-white/[.13] bg-white/[.04] px-[13px] py-[10px] text-[14.5px] font-semibold text-[#F1F5F9]"
      />
      <div ref={pipeRef} className="mb-4 mt-3 flex flex-wrap gap-1.5" />
      <div ref={stageRef} className="min-h-[230px] flex-1" />
      <div className="mt-auto flex justify-between pt-3 text-[11.5px] text-[#64748B]">
        <span>
          <b className="text-[#94A3B8]">15</b> templates ·{' '}
          <b className="text-[#94A3B8]">12</b> legal playbooks
        </span>
        <span className="text-[#94A3B8]">● Draft for attorney review</span>
      </div>
    </div>
  )
}
