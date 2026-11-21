'use client'

// Door check-in roster (EVENT-CHECKIN.A; layout CHECKINLAYOUT.1).
//
// A sticky bar (progress, search, To arrive / In / All), then one slim row per
// person sorted by first name. People booked together sit in one bracket with
// "Check in all". An event with more than one start time is grouped by time:
// each header carries its own count and folds; the first time with anyone
// still to arrive opens on its own, and a search opens every time it matches.
// Every tap shows an Undo toast. Optimistic updates with revert-on-failure.
// Talks to /api/events/[id]/checkin (+ /all). Phone-browser friendly.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Check, ChevronDown, ChevronRight, QrCode, X } from 'lucide-react'
import { buildCheckinView, defaultOpenGroup } from '@/lib/event-checkins'

// HOSTCHECKIN.1 — the host portal's theme tokens for the same page. Every
// class is written out in full (Tailwind only builds classes it can see).
const HOST_CLASSES = {
  '-mx-6': '-mx-4',
  'px-6': 'px-4',
  'bg-un1t-bg/95': 'bg-host-bg/95',
  'bg-un1t-bg': 'bg-host-well',
  'hover:bg-un1t-bg': 'hover:bg-host-hover',
  'bg-un1t-border/60': 'bg-host-border',
  'bg-un1t-surface': 'bg-host-panel',
  'bg-un1t-text': 'bg-host-accent',
  'text-un1t-bg': 'text-host-on-accent',
  'border-un1t-border': 'border-host-border',
  'border-un1t-muted': 'border-host-edge',
  'border-l-un1t-muted': 'border-l-host-edge',
  'text-un1t-text': 'text-host-text',
  'hover:text-un1t-text': 'hover:text-host-text',
  'text-un1t-subtle': 'text-host-hint',
  'bg-emerald-500/10': 'bg-host-ok-bg',
  'text-emerald-800': 'text-host-ok',
  'text-emerald-700': 'text-host-ok',
  'text-red-700': 'text-host-bad',
}

const TABS = [
  { key: 'arrive', label: 'To arrive' },
  { key: 'in', label: 'In' },
  { key: 'all', label: 'All' },
]

/**
 * Props: eventId, isRace, registrations; apiBase (default the staff routes,
 * `/api/events/<id>/checkin`; hosts pass `/api/host/events/<id>/checkin`);
 * host (the host portal's theme).
 */
export default function EventCheckinClient({ eventId, isRace, registrations: initial, apiBase = null, host = false }) {
  const base = apiBase || `/api/events/${eventId}/checkin`
  const th = (cls) => (host ? cls.split(/\s+/).map((c) => HOST_CLASSES[c] || c).join(' ') : cls)
  const [registrations, setRegistrations] = useState(initial || [])
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('arrive')
  const [busy, setBusy] = useState({})
  const [toast, setToast] = useState(null) // { text, undo }
  const [error, setError] = useState(null)
  const toastTimer = useRef(null)

  const view = useMemo(() => buildCheckinView(registrations, { tab, query }), [registrations, tab, query])
  // Counts and the default open time come from the full roster, not the tab.
  const all = useMemo(() => buildCheckinView(registrations, { tab: 'all' }), [registrations])
  const [open, setOpen] = useState(() => new Set([defaultOpenGroup(buildCheckinView(initial || [], { tab: 'all' }).groups)].filter(Boolean)))

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  function showToast(text, undo) {
    clearTimeout(toastTimer.current)
    setToast({ text, undo })
    toastTimer.current = setTimeout(() => setToast(null), 5000)
  }

  function setMembers(regId, fn) {
    setRegistrations((prev) => prev.map((r) => (r.id !== regId ? r : { ...r, team: { ...r.team, team_members: r.team.team_members.map(fn) } })))
  }

  async function setOne(regId, member, next, { withToast = true } = {}) {
    setBusy((b) => ({ ...b, [member.id]: true }))
    setError(null)
    setMembers(regId, (m) => (m.id === member.id ? { ...m, checked_in: next } : m))
    try {
      const res = next
        ? await fetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ team_member_id: member.id, race_registration_id: regId }),
          })
        : await fetch(
            `${base}?team_member_id=${encodeURIComponent(member.id)}&race_registration_id=${encodeURIComponent(regId)}`,
            { method: 'DELETE' },
          )
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.success === false) throw new Error(json.error || 'failed')
      if (withToast) {
        showToast(next ? `${member.name} checked in` : `${member.name} marked not in`, () => setOne(regId, member, !next, { withToast: false }))
      }
      if (next && query) setQuery('') // ready for the next name at the door
    } catch {
      setMembers(regId, (m) => (m.id === member.id ? { ...m, checked_in: !next } : m))
      setError(`Could not update ${member.name}. Check the connection and try again.`)
    } finally {
      setBusy((b) => ({ ...b, [member.id]: false }))
    }
  }

  async function checkInAll(reg) {
    const before = new Map(reg.team.team_members.map((m) => [m.id, m.checked_in]))
    setError(null)
    setMembers(reg.id, (m) => ({ ...m, checked_in: true }))
    try {
      const res = await fetch(`${base}/all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ race_registration_id: reg.id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.success === false) throw new Error()
      const label = isRace && reg.team.team_members.length > 1 ? reg.team.name : `${reg.team.team_members.length} people`
      showToast(`${label} checked in`, null)
      if (query) setQuery('')
    } catch {
      setMembers(reg.id, (m) => ({ ...m, checked_in: before.has(m.id) ? before.get(m.id) : m.checked_in }))
      setError('Could not check them in. Check the connection and try again.')
    }
  }

  function toggleGroup(key) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const pct = all.expected ? Math.round((all.present / all.expected) * 100) : 0
  const searching = query.trim().length > 0
  const countFor = Object.fromEntries(all.groups.map((g) => [g.key, g]))
  const tabCount = { arrive: all.toArrive, in: all.present, all: all.expected }

  return (
    <div>
      <div className={th("sticky top-0 z-10 -mx-6 px-6 pt-2 pb-3 mb-3 bg-un1t-bg/95 backdrop-blur border-b border-un1t-border")}>
        <div className={th("flex items-center justify-between gap-3 text-sm")}>
          <span className={th("font-medium text-un1t-text")}>{all.present} of {all.expected} in</span>
          <span className={th("inline-flex items-center gap-1 text-[11px] text-un1t-subtle")}>
            <QrCode size={13} aria-hidden="true" /> Ticket QR: scan with your phone camera
          </span>
        </div>
        <div className={th("h-1.5 rounded-full bg-un1t-border/60 overflow-hidden mt-2")} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Checked in">
          <div className={th("h-full bg-emerald-500 transition-all")} style={{ width: `${pct}%` }} />
        </div>
        <div className={th("relative mt-3")}>
          <Search size={14} className={th("absolute left-3 top-1/2 -translate-y-1/2 text-un1t-subtle")} aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isRace ? 'Search name, email or team' : 'Search name or email'}
            aria-label="Search attendees"
            className={th("w-full pl-9 pr-8 py-2 bg-un1t-surface border border-un1t-border rounded-md text-sm text-un1t-text")}
          />
          {searching && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className={th("absolute right-2 top-1/2 -translate-y-1/2 text-un1t-subtle hover:text-un1t-text")}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className={th("grid grid-cols-3 gap-1 mt-2")} role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={th(`py-1.5 rounded-md text-xs border ${tab === t.key ? 'bg-un1t-surface border-un1t-muted text-un1t-text font-medium' : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'}`)}
            >
              {t.label} {tabCount[t.key]}
            </button>
          ))}
        </div>
      </div>

      {error && <p role="alert" className={th("text-sm text-red-700 mb-3")}>{error}</p>}

      {view.groups.every((g) => g.entries.length === 0) && !view.grouped ? (
        <p className={th("text-sm text-un1t-subtle py-10 text-center")}>
          {searching ? 'No matching attendees.' : tab === 'arrive' ? 'Everyone is in.' : tab === 'in' ? 'Nobody is checked in yet.' : 'Nobody is booked.'}
        </p>
      ) : (
        <div className={th("border border-un1t-border rounded-lg overflow-hidden bg-un1t-surface")}>
          {(view.grouped ? all.groups : view.groups).map((g) => {
            const shown = view.groups.find((v) => v.key === g.key)
            const entries = shown?.entries || []
            if (view.grouped && searching && entries.length === 0) return null
            const c = countFor[g.key] || g
            const isOpen = !view.grouped || searching || open.has(g.key)
            const done = c.expected > 0 && c.present === c.expected
            return (
              <section key={g.key} aria-label={view.grouped ? [g.time, g.label].filter(Boolean).join(' · ') || 'No time' : 'Attendees'}>
                {view.grouped && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={isOpen}
                    className={th("w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-un1t-bg border-b border-un1t-border text-left text-sm")}
                  >
                    <span className={th(`inline-flex items-center gap-1.5 min-w-0 truncate ${isOpen ? 'font-medium text-un1t-text' : 'text-un1t-subtle'}`)}>
                      {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                      {[g.time, g.label && g.label !== g.time ? g.label : null].filter(Boolean).join(' · ') || 'No time'}
                    </span>
                    <span className={th(`shrink-0 text-xs ${done ? 'text-emerald-700 font-medium' : 'text-un1t-subtle'}`)}>
                      {done ? `All ${c.expected} in` : `${c.present} of ${c.expected} in`}
                    </span>
                  </button>
                )}
                {isOpen && entries.length === 0 && view.grouped && (
                  <p className={th("px-3 py-3 text-xs text-un1t-subtle border-b border-un1t-border")}>
                    {tab === 'arrive' ? 'Everyone in this time is in.' : tab === 'in' ? 'Nobody in this time is checked in yet.' : 'Nobody is booked in this time.'}
                  </p>
                )}
                {isOpen && entries.map(({ reg, members }) => {
                  const everyone = reg.team.team_members
                  const together = everyone.length > 1
                  const allIn = everyone.every((m) => m.checked_in)
                  const lead = everyone[0]?.name
                  return (
                    <div key={reg.id} className={th(`border-b border-un1t-border last:border-b-0 ${together ? 'border-l-[3px] border-l-un1t-muted' : ''}`)}>
                      {together && (
                        <div className={th("flex items-center justify-between gap-2 px-3 pt-2")}>
                          <span className={th("text-xs font-medium text-un1t-text truncate")}>
                            {isRace ? reg.team.name : `Booked together · ${everyone.length}`}
                          </span>
                          {!allIn && (
                            <button
                              type="button"
                              onClick={() => checkInAll(reg)}
                              className={th("shrink-0 text-[11px] px-2.5 py-1 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text")}
                            >
                              {everyone.length === 2 ? 'Check in both' : 'Check in all'}
                            </button>
                          )}
                        </div>
                      )}
                      {members.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setOne(reg.id, m, !m.checked_in)}
                          disabled={!!busy[m.id]}
                          aria-pressed={!!m.checked_in}
                          className={th(`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left text-sm disabled:opacity-60 ${
                            m.checked_in ? 'bg-emerald-500/10 text-emerald-800' : 'text-un1t-text hover:bg-un1t-bg'
                          }`)}
                        >
                          <span className={th("min-w-0 truncate")}>
                            {m.name}
                            {together && !isRace && m.name !== lead && lead ? <span className={th("text-xs text-un1t-subtle")}> · with {lead.split(/\s+/)[0]}</span> : null}
                            {m.emailMatch && m.email ? <span className={th("block text-xs text-un1t-subtle truncate")}>{m.email}</span> : null}
                          </span>
                          <span
                            className={th(`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full border ${
                              m.checked_in ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-un1t-muted'
                            }`)}
                            aria-hidden="true"
                          >
                            {m.checked_in ? <Check size={14} /> : null}
                          </span>
                        </button>
                      ))}
                    </div>
                  )
                })}
              </section>
            )
          })}
          {view.grouped && searching && view.groups.every((g) => g.entries.length === 0) && (
            <p className={th("text-sm text-un1t-subtle py-10 text-center")}>No matching attendees.</p>
          )}
        </div>
      )}

      {toast && (
        <div role="status" className={th("sticky bottom-4 mt-4 mx-auto max-w-sm flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-un1t-text text-un1t-bg text-sm")}>
          <span className={th("truncate")}>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={() => { const u = toast.undo; setToast(null); u() }}
              className={th("shrink-0 font-medium underline underline-offset-2")}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
