// src/components/schedule/StatusDot.jsx
// ROSTERLOOK.1 — the roster's ONE way of saying "this day is / is not staffed":
// a dot, a short count only when something is wrong ("2 short"), and the
// sentence behind it as both a tooltip and visually hidden text. Used by the
// week view's day headers and the month view's cells, so the two cannot drift
// the way the Studio Overview tile ("UNDERMANNED 4/1") and the month badges
// ("!1", "↓1") did. Takes a dayHeaderStatus() result.
//
// The pill carries its own bg-un1t-bg so -700 text is readable on ANY header,
// including today's solid blue one. No 'use client': it has no state.
//
// 🔴 `relative` is load-bearing. sr-only is position:absolute + nowrap; with no
// positioned ancestor inside the roster's horizontal scroller the span is not
// clipped by it and widens the whole PAGE on a phone (browser-measured: 777px
// of document at 390). Every element here that holds an sr-only child anchors it.

const DOT = { ok: 'bg-emerald-600', short: 'bg-amber-500', empty: 'bg-red-600' }
const TEXT = { ok: 'text-emerald-700', short: 'text-amber-700', empty: 'text-red-700' }

export default function StatusDot({ status }) {
  if (!status || status.tone === 'none') return null
  return (
    <span
      data-testid="status-dot"
      data-tone={status.tone}
      title={status.title}
      className={`relative inline-flex items-center gap-1 rounded-full bg-un1t-bg px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap ${TEXT[status.tone]}`}
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[status.tone]}`} />
      {status.label && <span aria-hidden="true" data-visible-label>{status.label}</span>}
      <span className="sr-only">{status.srLabel}</span>
    </span>
  )
}
