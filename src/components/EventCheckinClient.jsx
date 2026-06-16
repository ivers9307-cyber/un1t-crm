'use client'

// Door check-in roster (EVENT-CHECKIN.A). Tap a person to mark them present
// (or undo), or "Check in all" for a whole team. Optimistic updates with
// revert-on-failure; a live "X / Y people in" counter; search by name/email/
// team. Talks to /api/events/[id]/checkin (+ /all). Phone-browser friendly.

import { useMemo, useState } from 'react'
import { Search, Check, Users } from 'lucide-react'
import { checkinCounts } from '@/lib/event-checkins'

export default function EventCheckinClient({ eventId, isRace, registrations: initial }) {
  const [registrations, setRegistrations] = useState(initial || [])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState({})

  const counts = useMemo(
    () => checkinCounts(registrations.map((r) => ({ status: 'confirmed', team: r.team }))),
    [registrations],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return registrations
    return registrations
      .map((r) => {
        const teamMatch = (r.team.name || '').toLowerCase().includes(q)
        const members = teamMatch
          ? r.team.team_members
          : r.team.team_members.filter(
              (m) =>
                (m.name || '').toLowerCase().includes(q) ||
                (m.email || '').toLowerCase().includes(q),
            )
        return members.length ? { ...r, team: { ...r.team, team_members: members } } : null
      })
      .filter(Boolean)
  }, [registrations, query])

  function patchMember(regId, memberId, checked_in) {
    setRegistrations((prev) =>
      prev.map((r) =>
        r.id !== regId
          ? r
          : { ...r, team: { ...r.team, team_members: r.team.team_members.map((m) => (m.id === memberId ? { ...m, checked_in } : m)) } },
      ),
    )
  }

  function patchTeam(regId, checked_in) {
    setRegistrations((prev) =>
      prev.map((r) =>
        r.id !== regId
          ? r
          : { ...r, team: { ...r.team, team_members: r.team.team_members.map((m) => ({ ...m, checked_in })) } },
      ),
    )
  }

  async function toggleMember(regId, member) {
    const next = !member.checked_in
    setBusy((b) => ({ ...b, [member.id]: true }))
    patchMember(regId, member.id, next)
    try {
      const res = next
        ? await fetch(`/api/events/${eventId}/checkin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ team_member_id: member.id, race_registration_id: regId }),
          })
        : await fetch(
            `/api/events/${eventId}/checkin?team_member_id=${encodeURIComponent(member.id)}&race_registration_id=${encodeURIComponent(regId)}`,
            { method: 'DELETE' },
          )
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.success === false) throw new Error(json.error || 'failed')
    } catch {
      patchMember(regId, member.id, !next) // revert
    } finally {
      setBusy((b) => ({ ...b, [member.id]: false }))
    }
  }

  async function checkInTeam(reg) {
    const prevState = reg.team.team_members.map((m) => ({ id: m.id, checked_in: m.checked_in }))
    patchTeam(reg.id, true)
    try {
      const res = await fetch(`/api/events/${eventId}/checkin/all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ race_registration_id: reg.id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.success === false) throw new Error()
    } catch {
      // Revert to the exact prior per-member state.
      setRegistrations((prev) =>
        prev.map((r) =>
          r.id !== reg.id
            ? r
            : {
                ...r,
                team: {
                  ...r.team,
                  team_members: r.team.team_members.map((m) => {
                    const was = prevState.find((p) => p.id === m.id)
                    return was ? { ...m, checked_in: was.checked_in } : m
                  }),
                },
              },
        ),
      )
    }
  }

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-6 px-6 py-2 mb-3 bg-un1t-bg/95 backdrop-blur border-b border-un1t-border flex items-center gap-2">
        <Users size={16} className="text-un1t-subtle" />
        <span className="text-sm font-medium text-un1t-text">
          {counts.present} / {counts.expected} people in
        </span>
      </div>

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-un1t-subtle" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, email or team…"
          className="w-full pl-9 pr-3 py-2 bg-un1t-surface border border-un1t-border rounded-md text-sm text-un1t-text"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-un1t-subtle py-10 text-center">No matching attendees.</p>
      ) : (
        <div className="space-y-3">
          {filtered.map((reg) => {
            const members = reg.team.team_members
            const allIn = members.length > 0 && members.every((m) => m.checked_in)
            const showTeamName = isRace && members.length > 1
            return (
              <div key={reg.id} className="bg-un1t-surface border border-un1t-border rounded-lg p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    {showTeamName && <div className="font-medium text-un1t-text truncate">{reg.team.name}</div>}
                    {reg.wave_label && <div className="text-[11px] text-un1t-subtle">{reg.wave_label}</div>}
                  </div>
                  {members.length > 1 && (
                    <button
                      type="button"
                      onClick={() => checkInTeam(reg)}
                      disabled={allIn}
                      className="shrink-0 text-[11px] px-2.5 py-1 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-40"
                    >
                      {allIn ? 'All in' : 'Check in all'}
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  {members.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleMember(reg.id, m)}
                      disabled={!!busy[m.id]}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md border text-left text-sm disabled:opacity-60 ${
                        m.checked_in
                          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-800'
                          : 'bg-un1t-bg border-un1t-border text-un1t-text hover:border-un1t-muted'
                      }`}
                    >
                      <span className="min-w-0 truncate">
                        {m.name}
                        {m.email ? <span className="text-un1t-subtle"> · {m.email}</span> : null}
                      </span>
                      <span
                        className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full border ${
                          m.checked_in ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-un1t-border'
                        }`}
                      >
                        {m.checked_in ? <Check size={12} /> : null}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
