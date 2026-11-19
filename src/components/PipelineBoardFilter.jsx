'use client'

// BOARDFILTER.1 — the board's search box and "Stuck 21+ days" toggle.
//
// Both live in the URL (?q=, ?stuck=1) and the server filters every column's
// read and count (src/lib/pipeline-board-filter.js), so a pile of thousands is
// searched whole and a reload or shared link keeps the filter. Typing waits
// briefly before it navigates; Enter goes at once. The open contact drawer is
// closed by a new filter (its card may no longer be on the board).
// CONTACTLOG.1 — "Not contacted" (?nocontact=1) sits beside Stuck, on the same view.

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Search, X, Clock, UserX } from 'lucide-react'
import { BOARD_SEARCH_MAX } from '@/lib/pipeline-board-filter'
import { CONTACT_WINDOW_DAYS } from '@/lib/contact-log'

/** Pause after the last keystroke before the board reloads. */
export const BOARD_SEARCH_DEBOUNCE_MS = 350

// `showStuck` is false on the Off funnel view, where the piles never alarm.
export default function PipelineBoardFilter({ q = null, stuck = false, nocontact = false, showStuck = true }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [text, setText] = useState(q ?? '')
  const timer = useRef(null)

  // A navigation elsewhere (a board tab, back) brings a new q: follow it.
  useEffect(() => { setText(q ?? '') }, [q])
  useEffect(() => () => clearTimeout(timer.current), [])

  function go({ nextQ = text, nextStuck = stuck, nextNocontact = nocontact } = {}) {
    clearTimeout(timer.current)
    const p = new URLSearchParams(searchParams?.toString() ?? '')
    const term = String(nextQ ?? '').trim()
    if (term) p.set('q', term)
    else p.delete('q')
    if (nextStuck) p.set('stuck', '1')
    else p.delete('stuck')
    if (nextNocontact) p.set('nocontact', '1')
    else p.delete('nocontact')
    p.delete('contact')
    if ((p.get('q') ?? '') === (q ?? '') && p.has('stuck') === stuck && p.has('nocontact') === nocontact) return
    const qs = p.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  function onChange(e) {
    const v = e.target.value
    setText(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => go({ nextQ: v }), BOARD_SEARCH_DEBOUNCE_MS)
  }

  return (
    <form
      role="search"
      className="flex flex-wrap items-center gap-2 mb-3"
      onSubmit={(e) => { e.preventDefault(); go() }}
    >
      <label className="relative flex-1 min-w-[12rem] max-w-sm">
        <span className="sr-only">Search the board by name</span>
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-un1t-subtle pointer-events-none" aria-hidden="true" />
        <input
          type="search"
          value={text}
          onChange={onChange}
          maxLength={BOARD_SEARCH_MAX}
          placeholder="Search by name"
          autoComplete="off"
          className="w-full h-9 pl-8 pr-8 text-sm rounded-lg border border-un1t-border bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
        />
        {text && (
          <button
            type="button"
            onClick={() => { setText(''); go({ nextQ: '' }) }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-un1t-subtle hover:text-un1t-text"
            aria-label="Clear search"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </label>
      {showStuck && (
      <button
        type="button"
        aria-pressed={stuck}
        onClick={() => go({ nextStuck: !stuck })}
        className={`inline-flex items-center gap-1.5 h-9 px-3 text-sm rounded-lg border transition-colors ${
          stuck
            ? 'bg-red-500/10 text-red-700 border-red-500/40'
            : 'bg-white text-un1t-subtle border-un1t-border hover:text-un1t-text'
        }`}
        title="Cards 21 or more days in their column (the red age line)"
      >
        <Clock size={14} aria-hidden="true" />
        Stuck 21+ days
      </button>
      )}
      {showStuck && (
      <button
        type="button"
        aria-pressed={nocontact}
        onClick={() => go({ nextNocontact: !nocontact })}
        className={`inline-flex items-center gap-1.5 h-9 px-3 text-sm rounded-lg border transition-colors ${
          nocontact
            ? 'bg-blue-500/10 text-blue-700 border-blue-500/40'
            : 'bg-white text-un1t-subtle border-un1t-border hover:text-un1t-text'
        }`}
        title={`People with no call, WhatsApp or email logged here in the last ${CONTACT_WINDOW_DAYS} days`}
      >
        <UserX size={14} aria-hidden="true" />
        Not contacted
      </button>
      )}
    </form>
  )
}
