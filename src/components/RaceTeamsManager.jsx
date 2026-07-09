'use client'

// RaceTeamsManager — operator team-management UI for a race.
//
// Polls /api/events/[id]/teams once on load, then refreshes after
// every successful mutation. Each team card has inline edit
// affordances rather than a per-team modal — operators can scan +
// adjust without context-switching.

import { useEffect, useState } from 'react'
import { Plus, Trash2, Loader2, AlertCircle, Users, Check, X, Pencil, Star, BadgeCheck, Clock, Copy, Ban, MessageSquare, Download } from 'lucide-react'

export default function RaceTeamsManager({ race }) {
  const [registrations, setRegistrations] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [actionError, setActionError] = useState(null)

  const waves = (race?.waves || []).slice().sort((a, b) =>
    (a.display_order ?? 0) - (b.display_order ?? 0) || (a.start_time || '').localeCompare(b.start_time || '')
  )

  async function load() {
    try {
      const r = await fetch(`/api/events/${race.id}/teams`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setLoadError(j.error || `Fetch failed (${r.status})`)
        return
      }
      setRegistrations(j.data || [])
      setLoadError(null)
    } catch (e) {
      setLoadError(e.message || 'Network error')
    }
  }

  useEffect(() => { load() }, [race.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError && !registrations) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {loadError}
      </div>
    )
  }
  if (!registrations) {
    return (
      <div className="text-sm text-un1t-subtle inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading teams…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {actionError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {actionError}
          <button onClick={() => setActionError(null)} className="ml-auto"><X size={12} /></button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-sm text-un1t-subtle">
          {registrations.length} team{registrations.length === 1 ? '' : 's'} registered
        </div>
        <div className="flex items-center gap-2">
          {registrations.length > 0 && (
            <a
              href={`/api/events/${race.id}/teams/export`}
              download
              className="text-xs border border-un1t-border text-un1t-text px-3 py-1.5 rounded-md hover:bg-un1t-bg inline-flex items-center gap-1.5"
              title="Export every attendee (name, email, role, booking phone) as CSV"
            >
              <Download size={12} /> Export CSV
            </a>
          )}
          {!showAddForm && (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent inline-flex items-center gap-1.5"
            >
              <Plus size={12} /> Add team
            </button>
          )}
        </div>
      </div>

      {showAddForm && (
        <AddTeamForm
          race={race}
          waves={waves}
          onCancel={() => setShowAddForm(false)}
          onAdded={() => { setShowAddForm(false); load() }}
          onError={setActionError}
        />
      )}

      {registrations.length === 0 && !showAddForm && (
        <div className="text-sm text-un1t-subtle italic px-2 py-8 text-center">
          No teams yet.
        </div>
      )}

      <div className="space-y-3">
        {registrations.map((reg) => (
          <TeamCard
            key={reg.id}
            registration={reg}
            waves={waves}
            onChanged={load}
            onError={setActionError}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Add team form ───────────────────────────────────────────────

function AddTeamForm({ race, waves, onCancel, onAdded, onError }) {
  const sizes = (race.allowed_team_sizes || [1, 2, 4]).slice().sort((a, b) => a - b)
  const [teamName, setTeamName] = useState('')
  const [teamSize, setTeamSize] = useState(sizes[0])
  const [waveId, setWaveId] = useState(waves[0]?.id || '')
  const [members, setMembers] = useState(() =>
    Array.from({ length: sizes[0] }, (_, i) => ({ name: '', email: '', role: i === 0 ? 'captain' : 'member' }))
  )
  const [busy, setBusy] = useState(false)

  // Reshape members when size changes.
  useEffect(() => {
    setMembers((prev) => {
      const next = []
      for (let i = 0; i < teamSize; i++) {
        next.push(prev[i] || { name: '', email: '', role: i === 0 ? 'captain' : 'member' })
      }
      return next
    })
  }, [teamSize])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!teamName.trim()) return onError('Team name is required.')
    if (!waveId) return onError('Pick a wave.')
    for (const m of members) {
      if (!m.name.trim()) return onError('Every member needs a name.')
    }

    setBusy(true)
    try {
      const r = await fetch(`/api/events/${race.id}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_name: teamName.trim(),
          team_size: teamSize,
          wave_id: waveId,
          members: members.map((m, i) => ({
            name: m.name.trim(),
            email: m.email.trim() || null,
            role: i === 0 ? 'captain' : 'member',
          })),
        }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        onError(j.error || `Add failed (${r.status})`)
        setBusy(false)
        return
      }
      onAdded()
    } catch (e) {
      onError(e.message || 'Network error')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
      <div className="text-xs uppercase tracking-wider text-un1t-subtle">New team</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <input
          type="text"
          required
          placeholder="Team name *"
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
          className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm"
        />
        <select
          value={teamSize}
          onChange={(e) => setTeamSize(Number(e.target.value))}
          className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm"
        >
          {sizes.map((s) => <option key={s} value={s}>{s}-person</option>)}
        </select>
        <select
          value={waveId}
          onChange={(e) => setWaveId(e.target.value)}
          className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm"
        >
          {waves.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label ? `${w.label} · ` : ''}{(w.start_time || '').slice(0, 5)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2 pt-2 border-t border-un1t-border/50">
        <div className="text-[11px] text-un1t-subtle uppercase tracking-wider">Members (first row = captain)</div>
        {members.map((m, i) => (
          <div key={i} className="grid grid-cols-2 gap-2">
            <input
              type="text"
              required
              placeholder={i === 0 ? 'Captain name *' : `Member ${i + 1} name *`}
              value={m.name}
              onChange={(e) => setMembers((prev) => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
              className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm"
            />
            <input
              type="email"
              placeholder="Email (optional)"
              value={m.email}
              onChange={(e) => setMembers((prev) => prev.map((x, j) => j === i ? { ...x, email: e.target.value } : x))}
              className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm"
            />
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-3 py-1.5 text-un1t-subtle hover:text-un1t-text"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent inline-flex items-center gap-1.5 disabled:opacity-40"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          {busy ? 'Adding…' : 'Add team'}
        </button>
      </div>
    </form>
  )
}

// ─── One-team card ───────────────────────────────────────────────

function TeamCard({ registration, waves, onChanged, onError }) {
  const team = registration.teams
  const wave = registration.wave
  const members = (team?.team_members || []).slice().sort((a, b) =>
    (a.role === 'captain' ? 0 : 1) - (b.role === 'captain' ? 0 : 1)
  )
  const [showAddMember, setShowAddMember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [smsState, setSmsState] = useState(null) // null | 'sending' | 'sent'

  async function moveWave(newWaveId) {
    if (newWaveId === registration.wave_id) return
    setBusy(true)
    try {
      const r = await fetch(`/api/event-registrations/${registration.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wave_id: newWaveId }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) onError(j.error || `Move failed`)
      else onChanged()
    } catch (e) {
      onError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  async function copyPaymentLink() {
    // Link to our own /event-pay page (embedded checkout for either
    // provider) rather than a provider-hosted URL — Stripe Connect events
    // have no hosted URL. Same origin as the CRM, so window.origin is safe.
    const paymentId = registration.payment?.id
    const url = paymentId ? `${window.location.origin}/event-pay/${paymentId}` : null
    if (!url) { onError('No payment link available for this team yet.'); return }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      onError(`Couldn't copy automatically. Link: ${url}`)
    }
  }

  // Text the registrant their payment link via the platform's Twilio
  // sender (company number, not the operator's phone). The route
  // re-reads the payment row server-side — the phone surfaced on
  // registration.payment is only for gating + the confirm dialog.
  async function sendPaymentSms() {
    const phone = registration.payment?.contact_phone
    if (!phone) { onError('No phone number on file for this registrant.'); return }
    const who = registration.payment?.contact_name || team?.name || 'this registrant'
    if (!confirm(`Text the payment link to ${who} at ${phone}?`)) return
    setSmsState('sending')
    try {
      const r = await fetch(`/api/registrations/${registration.id}/payment-sms`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        onError(j.error || 'Could not send the payment SMS.')
        setSmsState(null)
        return
      }
      setSmsState('sent')
      setTimeout(() => setSmsState(null), 2500)
    } catch (e) {
      onError(e.message || 'Network error')
      setSmsState(null)
    }
  }

  // AGENT-EVENTS.3 follow-up — soft-cancel: frees the spot and keeps
  // the registration + payment history (vs Remove, which deletes the
  // row). Refunds, if any, are decided and processed manually in
  // Revolut — this never touches money.
  async function cancelRegistration() {
    if (!confirm(`Cancel team "${team?.name}"'s entry? The spot is freed but the registration and any payment record are kept. Refunds (if due) are handled separately in Revolut.`)) return
    setBusy(true)
    try {
      const r = await fetch(`/api/registrations/${registration.id}/cancel`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.success === false) onError(j.error || 'Cancel failed')
      else onChanged()
    } catch (e) {
      onError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  async function removeRegistration() {
    if (!confirm(`Remove team "${team?.name}" from this race?`)) return
    setBusy(true)
    try {
      const r = await fetch(`/api/event-registrations/${registration.id}`, { method: 'DELETE' })
      const j = await r.json()
      if (!r.ok || j.success === false) onError(j.error || `Remove failed`)
      else onChanged()
    } catch (e) {
      onError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-semibold text-un1t-text">{team?.name || '(no team)'}</span>
          {team?.size && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-un1t-border/40 text-un1t-subtle inline-flex items-center gap-1">
              <Users size={10} /> {team.size}-person
            </span>
          )}
          <StatusPill status={registration.status} />
          {registration.team_composition === 'all_members' && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 inline-flex items-center gap-1">
              <BadgeCheck size={10} /> Members
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={registration.wave_id || ''}
            onChange={(e) => moveWave(e.target.value)}
            disabled={busy}
            className="text-[11px] bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-un1t-text disabled:opacity-40"
            title="Move to a different wave"
          >
            {waves.map((w) => (
              <option key={w.id} value={w.id}>
                <Clock size={10} />{' '}
                {w.label ? `${w.label} · ` : ''}{(w.start_time || '').slice(0, 5)}
              </option>
            ))}
          </select>
          {registration.status === 'pending_payment' && registration.payment?.id && (
            <button
              type="button"
              onClick={copyPaymentLink}
              disabled={busy}
              className="text-[11px] text-un1t-accent hover:underline inline-flex items-center gap-1 disabled:opacity-40"
              title="Copy the payment link to send to the customer"
            >
              <Copy size={11} /> {copied ? 'Copied!' : 'Payment link'}
            </button>
          )}
          {registration.status === 'pending_payment' && registration.payment?.id && registration.payment?.contact_phone && (
            <button
              type="button"
              onClick={sendPaymentSms}
              disabled={busy || smsState === 'sending'}
              className="text-[11px] text-un1t-accent hover:underline inline-flex items-center gap-1 disabled:opacity-40"
              title={`Text the payment link to ${registration.payment.contact_phone}`}
            >
              {smsState === 'sending' ? (
                <><Loader2 size={11} className="animate-spin" /> Sending…</>
              ) : smsState === 'sent' ? (
                <><Check size={11} /> Sent!</>
              ) : (
                <><MessageSquare size={11} /> Text link</>
              )}
            </button>
          )}
          {registration.status === 'cancelled' ? (
            <span className="text-[11px] text-red-700 inline-flex items-center gap-1 font-medium">
              <Ban size={11} /> Cancelled
            </span>
          ) : (
            <button
              type="button"
              onClick={cancelRegistration}
              disabled={busy}
              className="text-[11px] text-un1t-subtle hover:text-amber-700 inline-flex items-center gap-1"
              title="Cancel this entry — frees the spot, keeps the registration and payment history (refunds handled in Revolut)"
            >
              <Ban size={11} /> Cancel entry
            </button>
          )}
          <button
            type="button"
            onClick={removeRegistration}
            disabled={busy}
            className="text-[11px] text-un1t-subtle hover:text-red-700 inline-flex items-center gap-1"
            title="Remove this team from the race entirely (deletes the registration)"
          >
            <Trash2 size={11} /> Remove
          </button>
        </div>
      </div>

      {wave && (
        <div className="text-[11px] text-un1t-subtle mt-1">
          Wave: {wave.label ? `${wave.label} · ` : ''}{(wave.start_time || '').slice(0, 5)}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-un1t-border/50 space-y-1.5">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} onChanged={onChanged} onError={onError} />
        ))}
        {showAddMember ? (
          <AddMemberRow
            teamId={team?.id}
            onAdded={() => { setShowAddMember(false); onChanged() }}
            onCancel={() => setShowAddMember(false)}
            onError={onError}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowAddMember(true)}
            className="text-[11px] text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
          >
            <Plus size={11} /> Add member
          </button>
        )}
      </div>
    </div>
  )
}

// ─── One member row ──────────────────────────────────────────────

function MemberRow({ member, onChanged, onError }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(member.name)
  const [email, setEmail] = useState(member.email || '')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const r = await fetch(`/api/team-members/${member.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim() || null }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) onError(j.error || 'Save failed')
      else { setEditing(false); onChanged() }
    } catch (e) {
      onError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!confirm(`Remove ${member.name} from this team?`)) return
    setBusy(true)
    try {
      const r = await fetch(`/api/team-members/${member.id}`, { method: 'DELETE' })
      const j = await r.json()
      if (!r.ok || j.success === false) onError(j.error || 'Remove failed')
      else onChanged()
    } catch (e) {
      onError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-sm"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email"
          className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-sm"
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="text-[11px] bg-emerald-600 text-white rounded px-2 py-1 disabled:opacity-40 inline-flex items-center gap-1"
          >
            {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
            Save
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setName(member.name); setEmail(member.email || '') }}
            disabled={busy}
            className="text-[11px] text-un1t-subtle hover:text-un1t-text"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-1.5">
        <span className={member.role === 'captain' ? 'text-un1t-text font-medium' : 'text-un1t-subtle'}>
          {member.name}
        </span>
        {member.role === 'captain' && <Star size={10} className="text-amber-700" />}
        {member.is_member && <BadgeCheck size={11} className="text-emerald-700" />}
        {member.email && <span className="text-[11px] text-un1t-muted">· {member.email}</span>}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-un1t-subtle hover:text-un1t-text p-1"
          title="Edit"
        >
          <Pencil size={11} />
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="text-un1t-subtle hover:text-red-700 p-1 disabled:opacity-40"
          title="Remove"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}

function AddMemberRow({ teamId, onAdded, onCancel, onError }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!name.trim()) return onError('Name is required.')
    setBusy(true)
    try {
      const r = await fetch(`/api/teams/${teamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim() || null }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) onError(j.error || 'Add failed')
      else onAdded()
    } catch (e) {
      onError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center pt-1">
      <input
        type="text"
        autoFocus
        placeholder="Member name *"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-sm"
      />
      <input
        type="email"
        placeholder="Email (optional)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-sm"
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="text-[11px] bg-emerald-600 text-white rounded px-2 py-1 disabled:opacity-40 inline-flex items-center gap-1"
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
          Add
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-[11px] text-un1t-subtle hover:text-un1t-text"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function StatusPill({ status }) {
  const map = {
    confirmed: 'bg-emerald-500/15 text-emerald-700',
    pending_payment: 'bg-amber-500/15 text-amber-700',
    cancelled: 'bg-gray-500/15 text-gray-600',
    no_show: 'bg-red-500/15 text-red-700',
  }
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${map[status] || 'bg-un1t-border/30 text-un1t-subtle'}`}>
      {status?.replaceAll('_', ' ')}
    </span>
  )
}
