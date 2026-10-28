'use client'

// UN1TCOMP.1 — complimentary un1t.online credits on the Hatch card (Richard
// approved the mock-up, 28 Oct 2026). Rendered by Un1tClassBookingCard on its
// credits line, only for staff who hold un1t_comp_credits at the studio (the
// class list's comp.can_grant; the route refuses 403 regardless).
//
// The form: credits 1 to 10, a use-by date (tomorrow to a year ahead, quick
// picks 1 week / 2 weeks / 1 month) on the STUDIO's clock (the class list's
// zone), a required reason, an optional team note, and, while the WhatsApp
// window is open, "Also send a WhatsApp message about the credits" (default
// on). The live line says what will happen; the primary button says how many.
// A done grant shows un1t.online's expiry, drops the studio's editable text
// into the open thread when ticked (best effort, never undoing the grant, the
// move's pattern), and asks the card to re-read the balance and the list.
// Below it: "Complimentary credits given" at this studio.

import { useMemo, useState } from 'react'
import { Gift, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui'
import {
  COMP_CREDIT_LIMITS as L,
  COMP_CREDIT_REASONS,
  compUseByBounds,
  compQuickPick,
  compSummary,
  compNoteProblem,
  formatUseBy,
} from '@/lib/un1t-comp-credits'
import { formatInZone } from '@shared/zoned-time'
import { compCreditsChatText } from '@/lib/book-chat-copy'
import { UN1T_STAFF_COPY } from '@/lib/un1t-staff-booking-copy'

const QUICK_PICKS = Object.freeze([
  { pick: 'week', label: '1 week' },
  { pick: 'two_weeks', label: '2 weeks' },
  { pick: 'month', label: '1 month' },
])

const newRequestId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : null)

// When a grant was given, as the studio's day.
function fmtDay(iso, zone) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return formatInZone(d, zone, { day: 'numeric', month: 'short' }, 'en-IE')
}

/**
 * @param {{ contactId: string, locationId: string, studioName: string, zone: string,
 *   canGrant: boolean, given: object[]|null, canWhatsApp: boolean, waConversationId?: string|null,
 *   onGranted?: () => void, nowMs?: number }} props
 *   nowMs: a fixed clock for tests; the card passes none (Date.now()).
 */
export default function Un1tCompCredits({ contactId, locationId, studioName, zone, canGrant, given, canWhatsApp, waConversationId, onGranted, nowMs }) {
  const now = nowMs ?? Date.now()
  const bounds = useMemo(() => compUseByBounds(zone, now), [zone, now])
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(1)
  const [useBy, setUseBy] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [requestId, setRequestId] = useState(null)

  const summary = compSummary({ amount, useBy, zone, nowMs: now })
  const noteProblem = compNoteProblem(note)
  const ready = !!summary && !!reason && !noteProblem && !!requestId && !busy

  function openForm() {
    setOpen(true)
    setResult(null)
    setAmount(1)
    setUseBy(compQuickPick('week', zone, now) ?? bounds.min)
    setReason('')
    setNote('')
    setNotify(true)
    setRequestId(newRequestId())
  }

  async function sendThreadText(text) {
    if (!canWhatsApp || !notify || !waConversationId) return ''
    try {
      const res = await fetch(`/api/whatsapp/conversations/${waConversationId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = await res.json().catch(() => ({}))
      return data.success ? ' Message sent in the chat.' : ` The chat message did not send (${data.error || 'window closed'}).`
    } catch {
      return ' The chat message did not send.'
    }
  }

  async function submit() {
    if (!ready) return
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/un1t-online/credits/comp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contactId, location_id: locationId, request_id: requestId,
          amount, use_by: useBy, reason, note: note.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.success) {
        const text = compCreditsChatText({ credits: amount, date: formatUseBy(useBy), studio: studioName, template: data.data?.chat_template })
        const threadNote = await sendThreadText(text)
        setResult({ ok: true, message: `${data.data?.message || UN1T_STAFF_COPY.compAdded(amount, formatUseBy(useBy))}${threadNote}` })
        setOpen(false)
        onGranted?.()
      } else {
        // The same request id stays: a second click on an unclear answer finds
        // that attempt on the ledger and sends nothing (reopening the form is
        // a new grant, after staff have checked un1t.online).
        setResult({ ok: false, message: data.issues?.[0]?.message || data.error || 'Adding the credits failed' })
      }
    } catch {
      setResult({ ok: false, message: UN1T_STAFF_COPY.compUnknown })
    } finally {
      setBusy(false)
    }
  }

  const list = Array.isArray(given) ? given : []

  return (
    <div className="mb-3">
      {canGrant && !open && (
        <Button variant="secondary" size="sm" icon={Gift} onClick={openForm}>Add complimentary credits</Button>
      )}
      {canGrant && open && (
        <div className="border border-un1t-border rounded-lg p-3 space-y-3 bg-un1t-bg" role="group" aria-label="Add complimentary credits">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-un1t-subtle">Credits</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Fewer credits"
                onClick={() => setAmount((n) => Math.max(L.minCredits, n - 1))}
                disabled={busy || amount <= L.minCredits}
                className="p-1 rounded-md border border-un1t-border text-un1t-text hover:bg-un1t-surface disabled:opacity-50"
              >
                <Minus size={12} />
              </button>
              <span className="w-6 text-center text-sm font-semibold text-un1t-text" aria-live="polite" data-testid="comp-amount">{amount}</span>
              <button
                type="button"
                aria-label="More credits"
                onClick={() => setAmount((n) => Math.min(L.maxCredits, n + 1))}
                disabled={busy || amount >= L.maxCredits}
                className="p-1 rounded-md border border-un1t-border text-un1t-text hover:bg-un1t-surface disabled:opacity-50"
              >
                <Plus size={12} />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <label className="text-xs text-un1t-subtle flex items-center gap-2">
              Use by
              <input
                type="date"
                aria-label="Use by"
                value={useBy}
                min={bounds.min}
                max={bounds.max}
                onChange={(e) => setUseBy(e.target.value)}
                disabled={busy}
                className="text-xs bg-un1t-surface border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
              />
            </label>
            {QUICK_PICKS.map(({ pick, label }) => {
              const day = compQuickPick(pick, zone, now)
              return (
                <button
                  key={pick}
                  type="button"
                  onClick={() => setUseBy(day)}
                  disabled={busy}
                  aria-pressed={useBy === day}
                  className={`text-[11px] px-2 py-1 rounded-md border ${useBy === day ? 'border-un1t-accent text-un1t-text bg-un1t-surface' : 'border-un1t-border text-un1t-subtle'} hover:bg-un1t-surface disabled:opacity-50`}
                >
                  {label}
                </button>
              )
            })}
          </div>

          <label className="block text-xs text-un1t-subtle">
            Reason
            <select
              aria-label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              className="mt-1 w-full text-xs bg-un1t-surface border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
            >
              <option value="">Choose a reason…</option>
              {COMP_CREDIT_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>

          <label className="block text-xs text-un1t-subtle">
            Team note (optional)
            <input
              type="text"
              aria-label="Team note"
              maxLength={L.noteMax}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              placeholder="Only the team sees this"
              className="mt-1 w-full text-xs bg-un1t-surface border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
            />
          </label>
          {noteProblem && <p className="text-[11px] text-red-700">{noteProblem}</p>}

          {canWhatsApp && (
            <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="rounded border-un1t-border" />
              Also send a WhatsApp message about the credits
            </label>
          )}

          <p className="text-xs text-un1t-text" data-testid="comp-summary">{summary || 'Choose a use-by date from tomorrow to a year ahead.'}</p>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={submit} disabled={!ready} loading={busy}>
              {`Add ${amount} credit${amount === 1 ? '' : 's'}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Close</Button>
          </div>
        </div>
      )}
      {result && <p className={`text-xs mt-2 ${result.ok ? 'text-emerald-700' : 'text-red-700'}`}>{result.message}</p>}

      {list.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-un1t-subtle mb-1.5">Complimentary credits given</p>
          <ul className="space-y-1">
            {list.map((g) => (
              <li key={g.id} className="text-xs text-un1t-text flex flex-wrap gap-x-1.5">
                <span>{fmtDay(g.at, zone)}</span>
                <span>· {g.amount} credit{g.amount === 1 ? '' : 's'}</span>
                <span>· {g.reason}</span>
                <span>· use by {formatUseBy(g.use_by)}</span>
                {g.by ? <span className="text-un1t-muted">· by {g.by}</span> : null}
                {!g.confirmed && <span className="text-amber-700">· unconfirmed, check un1t.online</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
