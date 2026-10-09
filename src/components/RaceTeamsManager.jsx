'use client'

// RaceTeamsManager — operator team-management UI for a race.
//
// Polls /api/events/[id]/teams once on load, then refreshes after
// every successful mutation. Each team card has inline edit
// affordances rather than a per-team modal — operators can scan +
// adjust without context-switching.

import { useEffect, useState } from 'react'
import { Plus, Trash2, Loader2, AlertCircle, Users, Check, X, Pencil, Star, BadgeCheck, Clock, Copy, Ban, Download, ArrowRightCircle } from 'lucide-react'
import MoveEntryDialog from './MoveEntryDialog'

// GATES-2 — `canCancelEntries` (the page's MANAGER_ROLES-at-the-event's-studio
// decision, the cancel route's rule) gates Cancel entry. Defaults closed.
// EVENT-MOVE.1 — `canMoveEntries` gates Move to event the same way (the move
// route's rule: races + MANAGER_ROLES at the studio). Defaults closed.
// `currency` is the event's payment_currency, for the outstanding-gap chip.
export default function RaceTeamsManager({ race, canCancelEntries = false, canMoveEntries = false, currency = 'EUR' }) {
  const [registrations, setRegistrations] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [actionError, setActionError] = useState(null)
  // EVENT-MOVE.1 — a warning that is not a failure (a move that landed but
  // could not be emailed). Amber, dismissable, separate from actionError.
  const [actionNotice, setActionNotice] = useState(null)
  const [movedOut, setMovedOut] = useState([])

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
      setMovedOut(Array.isArray(j.moved_out) ? j.moved_out : [])
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
      {actionNotice && (
        <div role="status" className="bg-amber-500/10 border border-amber-500/30 text-amber-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {actionNotice}
          <button type="button" onClick={() => setActionNotice(null)} className="ml-auto" aria-label="Dismiss notice"><X size={12} /></button>
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
            onNotice={setActionNotice}
            canCancel={canCancelEntries}
            canMove={canMoveEntries}
            currency={currency}
          />
        ))}
      </div>

      {movedOut.length > 0 && (
        <details className="text-sm text-un1t-subtle">
          <summary className="cursor-pointer select-none">
            {/* Counts moves, not entries: an entry moved out, back and out again is two. */}
            {movedOut.length} {movedOut.length === 1 ? 'move' : 'moves'} to other events
          </summary>
          <ul className="mt-2 space-y-1 pl-4">
            {movedOut.map((m) => (
              <li key={m.id}>
                {m.label} → {m.to_event?.name || 'another event'}{m.to_event?.race_date ? ` (${shortRaceDate(m.to_event.race_date)})` : ''} · {new Date(m.created_at).toLocaleDateString('en-IE')} · {actorOf(m)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

// EVENT-MOVE.1 — who made a move, for the chip and footer. A blank name
// (an actor with no profile name) reads "staff", never an empty gap.
function actorOf(move) {
  const name = typeof move?.actor_name === 'string' ? move.actor_name.trim() : ''
  return name || 'staff'
}

// EVENT-MOVE.3 — a settled difference shows nothing on the card except this
// note on the "Moved from" tooltip: how, who and when.
function settledNote(move) {
  if (!move?.gap_settled_at) return ''
  const how = move.gap_settled_how === 'waived' ? 'waived' : 'collected'
  const who = (typeof move.gap_settled_by_name === 'string' && move.gap_settled_by_name.trim()) || 'staff'
  return ` · difference ${how} by ${who} on ${new Date(move.gap_settled_at).toLocaleDateString('en-IE')}`
}

// Cents in the event's currency (same rendering as MoveEntryDialog).
// EVENT-MOVE.5 — who the payment link goes to, by name: the captain, else
// the first person, else the entry's payer, else the team.
function leadOf(registration) {
  const members = registration?.teams?.team_members || []
  const lead = members.find((m) => m?.role === 'captain') || members[0]
  return lead?.name || registration?.payment?.contact_name || registration?.teams?.name || 'the customer'
}

function money(cents, currency = 'EUR') {
  const major = (Math.abs(cents) / 100).toFixed(2)
  return currency === 'EUR' ? `€${major}` : currency === 'GBP' ? `£${major}` : `${major} ${currency}`
}

// A race_date ('YYYY-MM-DD') as "1 Nov". Read at noon so no timezone can tip
// it onto the day before.
function shortRaceDate(d) {
  const at = new Date(`${String(d).slice(0, 10)}T12:00:00`)
  return Number.isNaN(at.getTime()) ? String(d) : at.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })
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

function TeamCard({ registration, waves, onChanged, onError, onNotice, canCancel = false, canMove = false, currency = 'EUR' }) {
  const team = registration.teams
  const wave = registration.wave
  const members = (team?.team_members || []).slice().sort((a, b) =>
    (a.role === 'captain' ? 0 : 1) - (b.role === 'captain' ? 0 : 1)
  )
  const [showAddMember, setShowAddMember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [moving, setMoving] = useState(false)

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

  // EVENT-MOVE.3 — record that the move's price difference was collected
  // (a payment link, cash, …) or waived. Records a decision, never moves
  // money; only SQL can undo it, so ask first, like Cancel entry.
  async function settleGap(how) {
    const move = registration.last_move
    if (!move?.id) return
    if (!confirm(`Mark the ${money(move.price_gap_cents, currency)} difference as ${how}?`)) return
    setBusy(true)
    try {
      const r = await fetch(`/api/event-registrations/${registration.id}/moves/${move.id}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ how }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) onError(j.message || j.error || 'Could not save the difference')
      else {
        // Someone settled it first, the other way: say so rather than let
        // the reload quietly show an answer that is not the one clicked.
        const stood = j.data?.unchanged ? j.data.move : null
        if (stood?.gap_settled_how && stood.gap_settled_how !== how) {
          onNotice(`Already marked ${stood.gap_settled_how} by ${(typeof stood.gap_settled_by_name === 'string' && stood.gap_settled_by_name.trim()) || 'staff'}.`)
        }
        onChanged()
      }
    } catch (e) {
      onError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  // EVENT-MOVE.5 — email the customer a link to pay the difference (the
  // route reuses a pending one), and copy it so staff hold it either way.
  // Paying it marks the difference collected on its own.
  async function sendGapLink() {
    const move = registration.last_move
    if (!move?.id) return
    const lead = leadOf(registration)
    if (!confirm(`Send ${lead} a payment link for ${money(move.price_gap_cents, currency)}?`)) return
    setBusy(true)
    try {
      const r = await fetch(`/api/event-registrations/${registration.id}/moves/${move.id}/gap-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: true }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        onError(j.message || j.error || 'Could not create the payment link')
        // Settled meanwhile: reload so the chip clears.
        if (j.error === 'already_settled') onChanged()
        return
      }
      const url = j.data?.url || ''
      let copiedLink = false
      if (url) {
        try { await navigator.clipboard.writeText(url); copiedLink = true } catch { copiedLink = false }
      }
      if (j.data?.emailed) onNotice(`Payment link sent to ${lead}`)
      else if (copiedLink) onNotice('Payment link copied; the email could not be sent')
      else onNotice(`The email could not be sent. Payment link: ${url}`)
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
          {registration.last_move && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-700 inline-flex items-center gap-1"
              title={`Moved from ${registration.last_move.from_event?.name || 'another event'} by ${actorOf(registration.last_move)} on ${new Date(registration.last_move.created_at).toLocaleDateString('en-IE')}${registration.last_move.forced ? ' (wave was full)' : ''}${settledNote(registration.last_move)}`}
            >
              <ArrowRightCircle size={10} /> Moved from {registration.last_move.from_event?.name || 'another event'}
            </span>
          )}
          {registration.last_move && registration.last_move.notified_at === null && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700"
              title="The customer was not emailed about this move. Tell them yourself."
            >
              Not emailed
            </span>
          )}
          {registration.last_move?.price_gap_cents > 0 && !registration.last_move.gap_settled_at && (
            <span className="inline-flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700">
                {money(registration.last_move.price_gap_cents, currency)} difference outstanding
              </span>
              {canMove && (
                <>
                  <button
                    type="button"
                    onClick={() => settleGap('collected')}
                    disabled={busy}
                    className="text-[11px] text-un1t-accent hover:underline disabled:opacity-40"
                    title="The customer has paid the difference (payment link, cash, …)"
                  >
                    Collected
                  </button>
                  <button
                    type="button"
                    onClick={() => settleGap('waived')}
                    disabled={busy}
                    className="text-[11px] text-un1t-accent hover:underline disabled:opacity-40"
                    title="Let the difference go; the customer owes nothing more"
                  >
                    Waived
                  </button>
                  <button
                    type="button"
                    onClick={sendGapLink}
                    disabled={busy}
                    className="text-[11px] text-un1t-accent hover:underline disabled:opacity-40"
                    title="Email the customer a link to pay the difference (the link is copied too). Paying it marks the difference collected."
                  >
                    Send payment link
                  </button>
                </>
              )}
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
          {/* Confirmed only: an unpaid entry's payment link is priced for this event (EVENT-MOVE.4). */}
          {canMove && registration.status === 'confirmed' && (
            <button
              type="button"
              onClick={() => setMoving(true)}
              disabled={busy}
              className="text-[11px] text-un1t-accent hover:underline inline-flex items-center gap-1 disabled:opacity-40"
              title="Move this entry to another event"
            >
              <ArrowRightCircle size={11} /> Move to event
            </button>
          )}
          {registration.status === 'cancelled' ? (
            <span className="text-[11px] text-red-700 inline-flex items-center gap-1 font-medium">
              <Ban size={11} /> Cancelled
            </span>
          ) : canCancel && (
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

      {moving && (
        <MoveEntryDialog
          open
          registration={registration}
          onClose={() => setMoving(false)}
          onMoved={() => { setMoving(false); onChanged() }}
          onNotice={onNotice}
        />
      )}
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
